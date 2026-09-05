"""Installer checks use fresh directories and never call a real Docker daemon."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-release.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def test_fork_configuration_and_private_secret(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "deployment"
            installer.prepare(target, "chat.example.com", "v1.2.3", "example/fork", "ghcr.io/example")
            values = dict(line.split("=", 1) for line in (target / ".env").read_text().splitlines()
                          if line and not line.startswith("#") and "=" in line)
            self.assertEqual(values["APERTURE_PLATFORM_UPDATE_REPOSITORY"], "example/fork")
            self.assertEqual(values["APERTURE_IMAGE_REGISTRY"], "ghcr.io/example")
            self.assertEqual(values["APERTURE_WEB_ORIGINS"], "https://chat.example.com")
            self.assertEqual(values["APERTURE_IMAGE_TAG"], "v1.2.3")
            self.assertGreaterEqual(len(values["APERTURE_SECRET_KEY"]), 64)
            self.assertEqual((target / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertTrue((target / "infra/updater/updater.sh").is_file())

    def test_existing_directory_is_never_modified(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root)
            (target / ".env").write_text("existing secret")
            with self.assertRaisesRegex(ValueError, "already exists"):
                installer.prepare(target, "chat.example.com", "v1.2.3", "example/fork", "ghcr.io/example")
            self.assertEqual((target / ".env").read_text(), "existing secret")
            self.assertEqual(len(list(target.iterdir())), 1)

    def test_untrusted_configuration_cannot_inject_environment_lines(self):
        valid = ["chat.example.com", "v1.2.3", "example/fork", "ghcr.io/example"]
        for index in range(4):
            with self.subTest(field=index), tempfile.TemporaryDirectory() as root:
                values = valid.copy()
                values[index] += "\nCOMPOSE_PROJECT_NAME=other"
                with self.assertRaises(ValueError):
                    installer.prepare(Path(root) / "deployment", *values)
                self.assertFalse((Path(root) / "deployment").exists())


if __name__ == "__main__":
    unittest.main()
