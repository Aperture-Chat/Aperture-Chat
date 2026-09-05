import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData } from "../lib/types";
import { LibraryConsole } from "./LibraryConsole";

afterEach(() => vi.unstubAllGlobals());

test("failed tool creation leaves the catalog unchanged and retry opens the actual saved configuration", async () => {
  let currentData: BootstrapData = {
    ...sampleData, me: { ...sampleData.me, role: "PLATFORM_OWNER" }, tools: [],
  };
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporarily unavailable" }), { status: 503 }))
    .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      ...JSON.parse(String(init?.body)), id: "tool-verified", tenant_id: "tenant-example",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  function Harness() {
    const [data, setData] = useState(currentData);
    return <LibraryConsole data={data} view="tools" onDataChange={(updater) => setData((current) => {
      currentData = updater(current);
      return currentData;
    })} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add Tool" }));
  expect(await screen.findByText(/Tool was not created/)).toBeInTheDocument();
  expect(currentData.tools).toHaveLength(0);
  expect(screen.queryByText("New MCP Tool")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add Tool" }));
  await waitFor(() => expect(currentData.tools).toHaveLength(1));
  expect(currentData.tools[0].id).toBe("tool-verified");
  expect(currentData.tools[0].enabled).toBe(false);
  expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
  expect(screen.getByText(/Configure its connection below/)).toBeInTheDocument();
});

test.each(["upload", "web", "api"] as const)("%s source retry retains input and uses the already-created knowledge base", async (sourceType) => {
  let currentData: BootstrapData = {
    ...sampleData, me: { ...sampleData.me, role: "PLATFORM_OWNER" }, knowledgeBases: [],
  };
  let createdConfig: Record<string, unknown> = {};
  let sourceCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/admin/knowledge-configs") && init?.method === "POST") {
      createdConfig = { ...JSON.parse(String(init.body)), id: "knowledge-retry", tenant_id: "tenant-example" };
      return new Response(JSON.stringify(createdConfig), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/knowledge/knowledge-retry/") && init?.method === "POST") {
      sourceCalls += 1;
      if (sourceCalls === 1) return new Response(JSON.stringify({ detail: "Source unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ config: { ...createdConfig, settings: { status: "ready", document_count: 0 } }, documents: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  function Harness() {
    const [data, setData] = useState(currentData);
    return <LibraryConsole data={data} view="knowledge" onDataChange={(updater) => setData((current) => {
      currentData = updater(current);
      return currentData;
    })} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add Knowledge Base" }));
  const upload = new File(["Synthetic source document"], "source-notes.txt", { type: "text/plain" });
  if (sourceType === "upload") {
    fireEvent.change(screen.getByLabelText("Choose documents"), { target: { files: [upload] } });
  } else if (sourceType === "web") {
    fireEvent.click(screen.getByRole("radio", { name: /Web links/ }));
    fireEvent.change(screen.getByLabelText("Web address"), { target: { value: "https://example.com/source" } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Keep this source context" } });
  } else {
    fireEvent.click(screen.getByRole("radio", { name: /API Connect/ }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com/source" } });
    fireEvent.change(screen.getByLabelText("API key", { selector: "input" }), { target: { value: "synthetic-source-secret" } });
  }
  fireEvent.change(screen.getByLabelText("Knowledge base name"), { target: { value: "Retry Knowledge" } });
  fireEvent.click(screen.getByRole("button", { name: "Create with data source" }));
  const retryButton = await screen.findByRole("button", { name: "Retry source import" });
  expect(currentData.knowledgeBases).toHaveLength(1);
  expect(currentData.knowledgeBases[0].id).toBe("knowledge-retry");
  if (sourceType === "upload") expect(screen.getByText(/Selected: source-notes.txt/)).toBeInTheDocument();
  fireEvent.click(retryButton);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry source import" })).not.toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/api/admin/knowledge-configs") && init?.method === "POST")).toHaveLength(1);
  const requests = fetchMock.mock.calls.filter(([input, init]) => String(input).includes("/api/knowledge/knowledge-retry/") && init?.method === "POST");
  expect(requests).toHaveLength(2);
  if (sourceType === "upload") {
    expect((requests[1][1]?.body as FormData).getAll("files")).toEqual([upload]);
  } else {
    const retriedPayload = JSON.parse(String(requests[1][1]?.body));
    expect(retriedPayload).toEqual(JSON.parse(String(requests[0][1]?.body)));
    if (sourceType === "api") expect(retriedPayload.secret_value).toBe("synthetic-source-secret");
    else expect(retriedPayload.text).toBe("Keep this source context");
  }
  expect(currentData.knowledgeBases).toHaveLength(1);
});
