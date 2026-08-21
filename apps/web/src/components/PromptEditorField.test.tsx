import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { PromptEditorField } from "./PromptEditorField";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("improves, expands, and restores a long-form prompt without saving it", async () => {
  const improvedPrompts = [
    "Use connected sources, cite each material claim, and request approval before external communication.",
    "Use configured sources only, cite every material claim, and require approval before any external communication.",
  ];
  let responseIndex = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    expect(payload.messages[0].content).toContain("agent system prompt");
    expect(payload.messages[1].content).toContain(
      responseIndex === 0 ? "Use sources" : improvedPrompts[0],
    );
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: improvedPrompts[responseIndex++],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PromptFieldHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Expand system prompt" }));
  expect(screen.getByRole("dialog", { name: "System prompt" })).toBeInTheDocument();
  expect(screen.getByLabelText("Expanded system prompt")).toHaveValue("Use sources");
  fireEvent.click(screen.getByRole("button", { name: "Collapse system prompt" }));

  fireEvent.click(screen.getByRole("button", { name: "Improve system prompt" }));
  expect(await screen.findByRole("progressbar", { name: "Improving prompt" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByLabelText("System prompt")).toHaveValue(
      "Use connected sources, cite each material claim, and request approval before external communication.",
    ),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Improve system prompt" }));
  await waitFor(() => expect(screen.getByLabelText("System prompt")).toHaveValue(improvedPrompts[1]));
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Restore original system prompt" }));
  expect(screen.getByLabelText("System prompt")).toHaveValue("Use sources");
  expect(screen.queryByRole("button", { name: "Restore original system prompt" })).not.toBeInTheDocument();
});

function PromptFieldHarness() {
  const [value, setValue] = useState("Use sources");
  return (
    <PromptEditorField
      label="System prompt"
      kind="system"
      userId="user-owner"
      modelId="model-approved"
      value={value}
      onChange={setValue}
    />
  );
}
