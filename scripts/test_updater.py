#!/usr/bin/env python3
"""Exercise the release updater with a disposable project and a fake Docker CLI."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


UPDATER = Path(__file__).resolve().parents[1] / "infra/updater/updater.sh"
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[1:]
state = Path(os.environ["MOCK_STATE"])
events = state / "commands.jsonl"
mode = os.environ.get("MOCK_MODE", "success")

def record(event):
    with events.open("a") as out:
        out.write(json.dumps(event) + "\n")

def count():
    path = state / "up-count"
    return int(path.read_text()) if path.exists() else 0

if args[0] == "version":
    print("28.0.0")
elif args[0] == "inspect":
    fmt, cid = args[2:4]
    if "Labels" in fmt:
        values = {
            "com.docker.compose.project": "synthetic-updater",
            "com.docker.compose.project.working_dir": os.environ["MOCK_PROJECT"],
            "com.docker.compose.project.config_files": os.environ["MOCK_CONFIG"],
            "com.docker.compose.project.environment_file": os.environ.get("MOCK_ENV_LABEL", ""),
        }
        print(next((value for key, value in values.items() if '"' + key + '"' in fmt), ""))
    elif fmt == "{{.Image}}":
        print("sha256:" + ("1" if cid == "api-cid" else "2") * 64)
    elif ".State.Health" in fmt:
        if mode == "web-fails" and count() == 1 and cid == "web-cid":
            print("unhealthy")
        elif mode == "rollback-fails" and count() > 0:
            print("unhealthy")
        elif mode == "api-no-health" and cid == "api-cid":
            print("running")
        elif mode == "web-no-health" and cid == "web-cid":
            print("running")
        else:
            print("healthy")
    else:
        sys.exit("unexpected inspect")
elif args[0] == "compose":
    action_index = next(i for i, arg in enumerate(args) if arg in {"config", "ps", "pull", "up"})
    action = args[action_index]
    rest = args[action_index + 1:]
    if action == "config":
        print("api\nweb\nupdater")
    elif action == "ps":
        service = rest[-1]
        if not (mode == "missing-web" and service == "web"):
            print(service + "-cid")
    elif action == "pull":
        record({"action": "pull", "target": os.environ.get("APERTURE_IMAGE_TAG")})
        if mode == "pull-slow":
            before = (state / "heartbeat").read_text()
            time.sleep(2.1)
            record({"heartbeat_before": before, "heartbeat_after": (state / "heartbeat").read_text()})
        if mode == "pull-fails":
            sys.exit(1)
    elif action == "up":
        n = count() + 1
        (state / "up-count").write_text(str(n))
        files = os.environ["COMPOSE_FILE"].split(":")
        record({"action": "up", "args": rest, "env": Path(os.environ["MOCK_PROJECT"]).joinpath(".env").read_text(),
                "override": Path(files[-1]).read_text() if len(files) > 1 else None})
        if mode == "up-fails" and n == 1:
            sys.exit(1)
else:
    sys.exit("unexpected docker command")
'''


class UpdaterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="aperture-updater-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.project = self.root / "project"
        self.bin = self.root / "bin"
        for directory in (self.state, self.project, self.bin):
            directory.mkdir()
        self.env_file = self.project / ".env"
        self.env_file.write_text("APERTURE_IMAGE_TAG=dev\nSYNTHETIC_SETTING=keep-me\n")
        self.env_file.chmod(0o600)
        self.config = self.project / "compose.yml"
        self.config.write_text("services: {}\n")
        # Source the real production functions, without starting its daemon loop.
        self.functions = self.root / "functions.sh"
        self.functions.write_text(UPDATER.read_text().split("# --- Main loop")[0])
        fake = self.bin / "docker"
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o700)
        self.env = {
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            # Never inherit a real deployment's project/config override or
            # credentials into this fake-Docker test process.
            "TMPDIR": str(self.root),
            "APERTURE_UPDATER_STATE_DIR": str(self.state),
            "APERTURE_UPDATER_CONTAINER_ID": "synthetic-updater",
            "APERTURE_UPDATER_POLL_SECONDS": "0.05",
            "APERTURE_UPDATER_HEALTH_TIMEOUT_SECONDS": "1",
            "MOCK_STATE": str(self.state),
            "MOCK_PROJECT": str(self.project),
            "MOCK_CONFIG": str(self.config),
            "FUNCTIONS": str(self.functions),
        }
        self.write_request()

    def write_request(self, target: str = "v0.4.8", request_id: str = "upd-synthetic") -> None:
        (self.state / "request").write_text(
            f"id={request_id}\ntarget_version={target}\nprevious_version=v0.4.7\nrequested_by=synthetic-owner\n"
        )

    def run_script(self, script: str = "handle_request", mode: str = "success") -> str:
        result = subprocess.run(
            ["sh", "-c", '. "$FUNCTIONS"\n' + script],
            env={**self.env, "MOCK_MODE": mode},
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    def status(self) -> dict[str, str]:
        return dict(line.split("=", 1) for line in (self.state / "status").read_text().splitlines())

    def commands(self) -> list[dict]:
        file = self.state / "commands.jsonl"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def assert_original(self) -> None:
        self.assertEqual(self.env_file.read_text(), "APERTURE_IMAGE_TAG=dev\nSYNTHETIC_SETTING=keep-me\n")

    def test_success_checks_both_services_and_preserves_environment(self) -> None:
        self.run_script()
        self.assertEqual(self.status()["phase"], "succeeded")
        self.assertIn("APERTURE_IMAGE_TAG=v0.4.8\nSYNTHETIC_SETTING=keep-me", self.env_file.read_text())
        self.assertEqual(self.env_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.env_file.with_name(".env.aperture-updater.bak").stat().st_mode & 0o777, 0o600)
        commands = self.commands()
        self.assertEqual([item["action"] for item in commands], ["pull", "up"])
        self.assertEqual(commands[0]["target"], "v0.4.8")
        self.assertEqual(commands[1]["args"], ["-d", "--no-build", "api", "web"])
        self.assertFalse((self.state / "request").exists())
        self.assertFalse(any(self.state.glob("*env*")))

    def test_request_is_acknowledged_before_removal(self) -> None:
        self.run_script('''
rm() {
  if [ "$1" = "-f" ] && [ "${2:-}" = "$STATE_DIR/request" ]; then
    kv "$STATE_DIR/status" phase > "$STATE_DIR/phase-at-claim"
  fi
  command rm "$@"
}
handle_request
''')
        self.assertEqual((self.state / "phase-at-claim").read_text().strip(), "accepted")

    def test_pull_failure_does_not_recreate_or_rewrite(self) -> None:
        self.run_script(mode="pull-fails")
        self.assertEqual(self.status()["phase"], "failed")
        self.assert_original()
        self.assertEqual([item["action"] for item in self.commands()], ["pull"])

    def test_web_failure_restores_actual_images_and_previous_branch_tag(self) -> None:
        self.run_script(mode="web-fails")
        self.assertEqual(self.status()["phase"], "rolled_back")
        self.assert_original()
        rollback = [item for item in self.commands() if item["action"] == "up"][-1]
        self.assertIn('image: "sha256:' + "1" * 64 + '"', rollback["override"])
        self.assertIn('image: "sha256:' + "2" * 64 + '"', rollback["override"])
        self.assertEqual(rollback["override"].count("pull_policy: never"), 2)

    def test_start_failure_attempts_rollback(self) -> None:
        self.run_script(mode="up-fails")
        self.assertEqual(self.status()["phase"], "rolled_back")
        self.assert_original()

    def test_rollback_failure_reports_manual_attention(self) -> None:
        self.run_script(mode="rollback-fails")
        self.assertEqual(self.status()["phase"], "failed")
        self.assertIn("Manual attention required", self.status()["message"])

    def test_environment_write_failure_does_not_recreate(self) -> None:
        self.run_script("set_env_tag() { return 1; }\nhandle_request")
        self.assertEqual(self.status()["phase"], "failed")
        self.assert_original()
        self.assertFalse(any(item["action"] == "up" for item in self.commands()))

    def test_missing_rollback_image_prevents_pull_and_apply(self) -> None:
        self.run_script(mode="missing-web")
        self.assertEqual(self.status()["phase"], "failed")
        self.assert_original()
        self.assertEqual(self.commands(), [])

    def test_invalid_target_and_request_id_are_never_executed(self) -> None:
        for target, request_id in (("v0.4.8;touch malicious", "upd-synthetic"), ("v0.4.8", "../malicious")):
            with self.subTest(target=target, request_id=request_id):
                self.write_request(target, request_id)
                self.run_script()
                self.assertEqual(self.status()["phase"], "failed")
                self.assert_original()
                self.assertEqual(self.commands(), [])

    def test_slow_pull_continues_heartbeat(self) -> None:
        self.run_script(mode="pull-slow")
        observation = next(item for item in self.commands() if "heartbeat_before" in item)
        before = dict(line.split("=", 1) for line in observation["heartbeat_before"].splitlines())
        after = dict(line.split("=", 1) for line in observation["heartbeat_after"].splitlines())
        self.assertGreater(int(after["ts"]), int(before["ts"]))
        self.assertEqual(after["ready"], "1")
        self.assertEqual(self.status()["phase"], "succeeded")

    def test_api_running_without_health_is_not_success(self) -> None:
        for mode in ("api-no-health", "web-no-health"):
            with self.subTest(mode=mode):
                self.write_request()
                self.run_script(mode=mode)
                self.assertEqual(self.status()["phase"], "failed")
                self.assertIn("Manual attention required", self.status()["message"])

    def test_multiple_environment_files_require_manual_upgrade(self) -> None:
        self.env["MOCK_ENV_LABEL"] = "first.env,second.env"
        self.run_script()
        self.assertEqual(self.status()["phase"], "failed")
        self.assertIn("multiple environment files", self.status()["message"])
        self.assert_original()
        self.assertEqual(self.commands(), [])

    def test_failed_atomic_rewrite_keeps_original_environment(self) -> None:
        self.run_script('''
ENV_FILE="$MOCK_PROJECT/.env"
sed() { return 1; }
if set_env_tag v0.4.8; then exit 99; fi
''')
        self.assert_original()
        self.assertEqual(list(self.project.glob(".env.aperture-updater.*")), [])

    def test_restart_does_not_execute_already_acknowledged_request(self) -> None:
        (self.state / "status").write_text(
            "id=upd-synthetic\nphase=accepted\ntarget_version=v0.4.8\nprevious_version=v0.4.7\n"
        )
        self.run_script("recover_interrupted_run\nhandle_request")
        self.assertEqual(self.status()["phase"], "failed")
        self.assertFalse((self.state / "request").exists())
        self.assert_original()
        self.assertEqual(self.commands(), [])

    def test_restart_preserves_a_different_new_request(self) -> None:
        (self.state / "status").write_text(
            "id=upd-previous\nphase=pulling\ntarget_version=v0.4.8\nprevious_version=v0.4.7\n"
        )
        self.run_script("recover_interrupted_run")
        self.assertEqual(self.status()["phase"], "failed")
        self.assertTrue((self.state / "request").exists())


if __name__ == "__main__":
    unittest.main()
