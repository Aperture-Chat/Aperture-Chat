import { FlaskConical, TerminalSquare, X } from "lucide-react";
import { useId, useState } from "react";
import { StableLabel } from "./Primitives";
import type {
  AdminToolConfigCreateRequest,
  AdminToolConfigUpdateRequest,
  CustomScriptRunResult,
  Group,
  ToolConfig,
  ToolConfigRecord,
} from "../lib/types";

/* Admin builder for response actions: small scripts that add extra
 * buttons to assistant responses. They run server-side in an isolated
 * subprocess with CPU/memory/time limits and a clean environment, with no
 * platform secrets or provider keys. The remaining container-network limit is
 * stated in the dialog copy, never hidden. */

const DEFAULT_SCRIPT = `import sys

text = sys.stdin.read()

# Transform the assistant response however you need, then print the result.
print(text.upper())
`;

export type CustomToolBuilderApi = {
  createTool: (payload: AdminToolConfigCreateRequest) => Promise<ToolConfigRecord>;
  updateTool: (toolId: string, payload: AdminToolConfigUpdateRequest) => Promise<ToolConfigRecord>;
  previewScript: (payload: { script: string; input: string; timeout_seconds: number }) => Promise<CustomScriptRunResult>;
};

export function CustomToolBuilder({
  tool,
  groups,
  api,
  onClose,
  onSaved,
  brandName,
}: {
  tool: ToolConfig | null; // null = creating a new tool
  groups: Group[];
  api: CustomToolBuilderApi;
  onClose: () => void;
  onSaved: (record: ToolConfigRecord) => void;
  brandName?: string;
}) {
  const titleId = useId();
  const brand = brandName?.trim() || "Aperture Chat";
  const [name, setName] = useState(tool?.name ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [script, setScript] = useState(tool?.script ?? DEFAULT_SCRIPT);
  const [timeoutSeconds, setTimeoutSeconds] = useState(tool?.timeout_seconds ?? 10);
  const [allowedGroupIds, setAllowedGroupIds] = useState<string[]>(tool?.allowed_group_ids ?? []);
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<CustomScriptRunResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0 && script.trim().length > 0;

  function toggleGroup(groupId: string, next: boolean) {
    setAllowedGroupIds((current) =>
      next ? [...current, groupId] : current.filter((id) => id !== groupId),
    );
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    try {
      const result = await api.previewScript({
        script,
        input: testInput,
        timeout_seconds: timeoutSeconds,
      });
      setTestResult(result);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The test run failed.");
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const settings = {
      script,
      timeout_seconds: timeoutSeconds,
      description: description.trim(),
      status: "ready",
    };
    try {
      const record = tool
        ? await api.updateTool(tool.id, {
            name: name.trim(),
            allowed_group_ids: allowedGroupIds,
            settings,
          })
        : await api.createTool({
            name: name.trim(),
            tool_type: "custom_script",
            enabled: true,
            approval_required: false,
            allowed_group_ids: allowedGroupIds,
            settings,
          });
      onSaved(record);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The response action did not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal custom-tool-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <TerminalSquare size={20} />
          </span>
          <div>
            <h2 id={titleId}>{tool ? `Edit ${tool.name}` : "New response action"}</h2>
            <p>
              A response action adds an extra button to assistant messages. It receives the response text on stdin
              and prints the result, so admins can add exports or formatters without adding MCP servers.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close response action builder"
            data-tooltip="Close without saving"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="modal-body custom-tool-body">
          <div className="custom-tool-meta-grid">
            <label className="auth-field custom-tool-field">
              <span>Action name</span>
              <input
                value={name}
                placeholder="e.g. Export response as PowerPoint"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="auth-field custom-tool-field">
              <span>Timeout (seconds, 1–30)</span>
              <input
                type="number"
                min={1}
                max={30}
                value={timeoutSeconds}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setTimeoutSeconds(Math.max(1, Math.min(30, Math.round(next))));
                }}
              />
            </label>
          </div>
          <label className="auth-field custom-tool-field">
            <span>Description</span>
            <input
              value={description}
              placeholder="What this action adds to assistant responses"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <label className="auth-field custom-tool-field custom-tool-script-field">
            <span>Python script</span>
            <textarea
              className="custom-tool-script"
              value={script}
              rows={8}
              spellCheck={false}
              onChange={(event) => setScript(event.target.value)}
            />
          </label>

          <p className="custom-tool-sandbox-note">
            Response actions run in an isolated process with CPU, memory, and time limits, a throwaway working directory,
            and no platform secrets or provider keys. They can reach the network from inside the platform
            container, so only grant this action to groups you trust with that.
          </p>

          <details className="custom-tool-guide">
            <summary>
              <span>
                <strong>How to write scripts for {brand}</strong>
                <small>Input, output, downloadable files, and compatibility</small>
              </span>
            </summary>
            <div className="custom-tool-guide-body">
              <p>
                Response actions are standalone Python programs. Scripts copied from another platform usually need
                small changes before they will work in {brand}.
              </p>
              <ul>
                <li>
                  <strong>Read the response:</strong> Use <code>sys.stdin.read()</code> to receive the selected
                  assistant response as plain text.
                </li>
                <li>
                  <strong>Show a result:</strong> Print a short, user-friendly success message. Avoid logs, raw JSON,
                  or technical details unless the script fails.
                </li>
                <li>
                  <strong>Create downloads:</strong> Write files into the folder named by
                  <code> APERTURE_ARTIFACT_DIR</code>. {brand} supports PPTX, DOCX, XLSX, PDF, CSV, JSON, TXT, ZIP,
                  PNG, and JPG files.
                </li>
                <li>
                  <strong>Use available libraries:</strong> The Python standard library, python-pptx, lxml, Pillow,
                  and pydantic are available. Do not run pip installs inside a response action.
                </li>
                <li>
                  <strong>Adapt scripts from other products:</strong> Remove Open WebUI imports, event hooks, browser
                  callbacks, or other platform-specific APIs. Replace them with stdin, stdout, and the artifact folder.
                </li>
              </ul>
              <div className="custom-tool-guide-example">
                <strong>Minimal downloadable-file example</strong>
                <pre>{`import os
import sys
from pathlib import Path

text = sys.stdin.read()
output = Path(os.environ["APERTURE_ARTIFACT_DIR"]) / "response.txt"
output.write_text(text, encoding="utf-8")
print("Your file is ready.")`}</pre>
              </div>
              <p className="custom-tool-guide-tip">
                Use <strong>Run test</strong> with representative sample text before saving. A response action may
                create up to 8 files, with a 50 MB limit per file and 75 MB total per run.
              </p>
            </div>
          </details>

          {groups.length > 0 && (
            <div className="custom-tool-groups">
              <strong>Who can run this action</strong>
              <small>No groups selected means every active member of this workspace can use the button.</small>
              <div className="model-group-check-grid">
                {groups.map((group) => (
                  <label className="model-group-check" key={group.id}>
                    <input
                      type="checkbox"
                      checked={allowedGroupIds.includes(group.id)}
                      aria-label={`Allow ${group.name} to run this response action`}
                      onChange={(event) => toggleGroup(group.id, event.target.checked)}
                    />
                    <span>
                      <strong>{group.name}</strong>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="custom-tool-test">
            <strong>Test run</strong>
            <textarea
              aria-label="Test input for the script"
              value={testInput}
              rows={2}
              placeholder="Paste sample text the script will receive on stdin."
              onChange={(event) => setTestInput(event.target.value)}
            />
            <div className="model-filter-test-actions">
              <button
                className="secondary-button compact"
                type="button"
                disabled={!script.trim() || testing}
                data-tooltip="Run the script in the server sandbox against this sample"
                onClick={() => void runTest()}
              >
                <FlaskConical size={14} /> {testing ? "Running…" : "Run test"}
              </button>
            </div>
            {testResult && (
              <div
                className={`custom-tool-test-result ${testResult.status === "ok" ? "" : "is-error"}`}
                role="status"
              >
                <p>
                  {testResult.status === "ok"
                    ? `Finished in ${testResult.duration_ms} ms${testResult.truncated ? " (output truncated)" : ""}.`
                    : testResult.status === "timeout"
                      ? "The script timed out."
                      : `The script exited with an error (code ${testResult.exit_code ?? "?"}).`}
                </p>
                {testResult.output && <pre>{testResult.output}</pre>}
                {testResult.error && <pre className="custom-tool-test-stderr">{testResult.error}</pre>}
              </div>
            )}
          </div>

          {error && <p className="connector-config-error">{error}</p>}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!valid || saving}
              data-tooltip={tool ? "Save changes to this response action" : "Create this response action for the workspace"}
              onClick={() => void save()}
            >
              <StableLabel
                label={saving ? "Saving…" : tool ? "Save changes" : "Create action"}
                reserve={["Saving…", "Save changes", "Create action"]}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
