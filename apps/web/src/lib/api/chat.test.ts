import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelChatRun, saveChatThread, sendChat, sendChatStream } from "./chat";
import { ChatRequestError } from "./http";


const request = {
  model: "model-1",
  messages: [{ role: "user" as const, content: "Hello" }],
};


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("sendChat", () => {
  function completion(extra: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The draft." } }], ...extra }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  test("carries the research steps a whole reply took, dropping any it cannot read", async () => {
    completion({
      activity: [
        { kind: "step", number: 1, do: "calculate", ok: true, found: 1, about: "2 + 2" },
        { kind: "mystery" },
        "not a fact",
      ],
    });

    const reply = await sendChat("user-1", request);

    expect(reply.content).toBe("The draft.");
    expect(reply.activity).toEqual([{ kind: "step", number: 1, do: "calculate", ok: true, found: 1, about: "2 + 2" }]);
  });

  test("has no research to show when the API reports none", async () => {
    completion({});

    expect((await sendChat("user-1", request)).activity).toEqual([]);
  });
});


describe("sendChatStream", () => {
  test("accumulates SSE deltas and returns final metadata", async () => {
    const onDelta = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"delta":"Hello"}\n\n',
            'data: {"delta":" world"}\n\n',
            'data: {"done":true,"citations":[{"id":"c1","source_name":"Policy","source_type":"knowledge","source_uri":"knowledge://policy","snippet":"Seven years"}],"usage":null}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const reply = await sendChatStream("user-1", { ...request, onDelta });

    expect(onDelta).toHaveBeenNthCalledWith(1, "Hello");
    expect(onDelta).toHaveBeenNthCalledWith(2, "Hello world");
    expect(reply.content).toBe("Hello world");
    expect(reply.citations[0].source_name).toBe("Policy");
    expect(reply.usage).toBeUndefined();
  });

  test("reports the concealed prompt from the privacy event", async () => {
    const onConcealedPrompt = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"privacy":{"concealed_prompt":"SSN \u27e6SSN\u27e7"}}\n\n',
            'data: {"delta":"Noted."}\n\n',
            'data: {"done":true,"citations":[],"usage":null}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const reply = await sendChatStream("user-1", { ...request, onConcealedPrompt });

    expect(onConcealedPrompt).toHaveBeenCalledWith("SSN ⟦SSN⟧");
    expect(reply.concealedPrompt).toBe("SSN ⟦SSN⟧");
    expect(reply.content).toBe("Noted.");
  });

  test("throws the real stream error with partial text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          'data: {"delta":"Partial answer"}\n\ndata: {"error":"Provider disconnected"}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const error = await sendChatStream("user-1", request).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error.message).toBe("Provider disconnected");
    expect(error.partialText).toBe("Partial answer");
  });

  test("accepts an honest non-stream JSON fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { role: "assistant", content: "Complete reply" } }],
          citations: [],
          usage: { total_tokens: 12 },
        }),
      ),
    );

    const reply = await sendChatStream("user-1", request);

    expect(reply.content).toBe("Complete reply");
    expect(reply.usage?.total_tokens).toBe(12);
  });

  test("retries image models once through the existing complete-response path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Image models return complete responses; retry without streaming." },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { role: "assistant", content: "![Generated image](/image.png)" } }],
          citations: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", request);

    expect(reply.content).toContain("Generated image");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream).toBe(false);
  });
});

describe("sendChatStream activity", () => {
  test("passes each well-formed activity event to onActivity, in order", async () => {
    const onActivity = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"activity":{"kind":"knowledge","passages":4,"sources":2}}\n\n',
            'data: {"activity":{"kind":"mystery"}}\n\n',
            'data: {"delta":"Hi"}\n\n',
            'data: {"activity":{"kind":"continue","round":1}}\n\n',
            'data: {"delta":" there"}\n\n',
            'data: {"done":true,"citations":[],"usage":null}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const reply = await sendChatStream("user-1", { ...request, onActivity });

    expect(reply.content).toBe("Hi there");
    expect(onActivity.mock.calls.map(([activity]) => activity)).toEqual([
      { kind: "knowledge", passages: 4, sources: 2 },
      { kind: "continue", round: 1 },
    ]);
  });

  test("reports a client-side reconnect before the resumed attempt's events", async () => {
    const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(sse('data: {"delta":"First half."}\n\n'))
        .mockResolvedValueOnce(
          sse(
            'data: {"activity":{"kind":"screen","phase":"done"}}\n\ndata: {"delta":"Second half."}\n\ndata: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n',
          ),
        ),
    );
    const onActivity = vi.fn();

    await sendChatStream("user-1", { ...request, onActivity, resumeDelaysMs: [0] });

    expect(onActivity.mock.calls.map(([activity]) => activity)).toEqual([
      { kind: "resume", attempt: 1 },
      { kind: "screen-done" },
    ]);
  });
});

describe("sendChatStream resume hardening", () => {
  const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });

  test("resumes after a dropped stream and continues from the partial output", async () => {
    const fetchMock = vi
      .fn()
      // First attempt streams a partial then dies without the completion marker.
      .mockResolvedValueOnce(sse('data: {"delta":"First half."}\n\n'))
      // The resumed attempt finishes the answer.
      .mockResolvedValueOnce(
        sse('data: {"delta":"Second half."}\n\ndata: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();

    const reply = await sendChatStream("user-1", { ...request, onDelta, resumeDelaysMs: [0] });

    expect(reply.content).toBe("First half.\n\nSecond half.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The resume replays the conversation plus the partial answer and asks
    // the model to continue exactly where it stopped.
    const resumeBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(resumeBody.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First half." },
      { role: "user", content: expect.stringContaining("Continue exactly where the previous answer stopped") },
    ]);
    expect(onDelta).toHaveBeenLastCalledWith("First half.\n\nSecond half.");
  });

  test("retries an error the API marks retryable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sse('data: {"error":"Test Provider did not return a completion: HTTP 529","retryable":true}\n\ndata: [DONE]\n\n'),
      )
      .mockResolvedValueOnce(
        sse('data: {"delta":"Recovered answer"}\n\ndata: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] });

    expect(reply.content).toBe("Recovered answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("surfaces non-retryable provider errors without looping", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sse('data: {"error":"OpenRouter rejected the configured provider key with HTTP 401","retryable":false}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error.resumable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a user stop cancels immediately instead of resuming", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, signal: controller.signal }).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error.message).toBe("The response was cancelled before it finished.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("replays already-streamed text on the first request after a reload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sse('data: {"delta":"Second half."}\n\ndata: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n'),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", {
      ...request,
      initialText: "First half.",
      stallTimeoutMs: 0,
    });

    expect(reply.content).toBe("First half.\n\nSecond half.");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First half." },
      { role: "user", content: expect.stringContaining("Continue exactly where the previous answer stopped") },
    ]);
  });

  test("aborts a silent stream and resumes from the partial output", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            if (init?.signal?.aborted) {
              abort();
              return;
            }
            init?.signal?.addEventListener("abort", abort, { once: true });
          }),
      )
      .mockResolvedValueOnce(
        sse('data: {"delta":"Recovered after stall."}\n\ndata: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", {
      ...request,
      resumeDelaysMs: [0],
      stallTimeoutMs: 25,
    });

    expect(reply.content).toBe("Recovered after stall.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


describe("sendChatStream server runs", () => {
  const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const done = (position: number) =>
    `id: ${position}\ndata: {"done":true,"citations":[],"usage":null}\n\nid: ${position + 1}\ndata: [DONE]\n\n`;
  const url = (call: unknown[]) => String(call[0]);

  test("follows its run again after a dropped connection, from the last frame it saw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse('id: 1\ndata: {"delta":"First half."}\n\n'))
      .mockResolvedValueOnce(sse(`id: 2\ndata: {"delta":" Second half."}\n\n${done(3)}`));
    vi.stubGlobal("fetch", fetchMock);
    const onRun = vi.fn();

    const reply = await sendChatStream("user-1", { ...request, runId: "run-1", onRun, resumeDelaysMs: [0] });

    expect(reply.content).toBe("First half. Second half.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).run_id).toBe("run-1");
    expect(url(fetchMock.mock.calls[1])).toMatch(/\/api\/chat\/runs\/run-1\/events\?after=1$/);
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    expect(onRun).not.toHaveBeenCalled();
  });

  test("a frame cut off before its data arrived is read again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse('id: 1\ndata: {"delta":"A"}\n\nid: 2\n'))
      .mockResolvedValueOnce(sse(`id: 2\ndata: {"delta":"B"}\n\n${done(3)}`));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", { ...request, runId: "run-1", resumeDelaysMs: [0] });

    expect(reply.content).toBe("AB");
    expect(url(fetchMock.mock.calls[1])).toMatch(/after=1$/);
  });

  test("a page that comes back follows the run, starting from the reply so far", async () => {
    const snapshot = {
      snapshot: {
        base: "",
        text: "First half.",
        activities: [{ kind: "web", results: 2, engine: "searxng" }],
        concealed_prompt: null,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse(`id: 2\ndata: ${JSON.stringify(snapshot)}\n\nid: 3\ndata: {"delta":" More."}\n\n${done(4)}`));
    vi.stubGlobal("fetch", fetchMock);
    const order: string[] = [];
    const onDelta = vi.fn();

    const reply = await sendChatStream("user-1", {
      ...request,
      runId: "run-1",
      attach: true,
      initialText: "Fir",
      onDelta,
      onSnapshot: () => order.push("snapshot"),
      onActivity: (activity) => order.push(activity.kind),
    });

    expect(reply.content).toBe("First half. More.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(fetchMock.mock.calls[0])).toMatch(/\/api\/chat\/runs\/run-1\/events\?after=0$/);
    expect(order).toEqual(["snapshot", "web"]);
    expect(onDelta).toHaveBeenNthCalledWith(1, "First half.");
  });

  test("a resumed run's snapshot carries the text it continued", async () => {
    const snapshot = { snapshot: { base: "Earlier part", text: "next part", activities: [], concealed_prompt: null } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(sse(`id: 1\ndata: ${JSON.stringify(snapshot)}\n\n${done(2)}`)),
    );

    const reply = await sendChatStream("user-1", { ...request, runId: "run-1", attach: true, initialText: "Earl" });

    expect(reply.content).toBe("Earlier part\n\nnext part");
  });

  test("a run the server no longer has continues as a new run from the text so far", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "This reply is no longer running." }), { status: 404 }))
      .mockResolvedValueOnce(sse(`id: 1\ndata: {"delta":"Second half."}\n\n${done(2)}`));
    vi.stubGlobal("fetch", fetchMock);
    const onRun = vi.fn();

    const reply = await sendChatStream("user-1", {
      ...request,
      runId: "run-1",
      attach: true,
      initialText: "First half.",
      newRunId: () => "run-2",
      onRun,
      resumeDelaysMs: [60_000],
    });

    expect(reply.content).toBe("First half.\n\nSecond half.");
    expect(onRun).toHaveBeenCalledWith("run-2");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.run_id).toBe("run-2");
    expect(body.messages.at(-1).content).toContain("Continue exactly where the previous answer stopped");
  });

  test("a failure the API marks retryable starts a new run instead of following the failed one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse('id: 1\ndata: {"error":"HTTP 529","retryable":true}\n\n'))
      .mockResolvedValueOnce(sse(`id: 1\ndata: {"delta":"Recovered"}\n\n${done(2)}`));
    vi.stubGlobal("fetch", fetchMock);
    const onRun = vi.fn();

    const reply = await sendChatStream("user-1", {
      ...request,
      runId: "run-1",
      newRunId: () => "run-2",
      onRun,
      resumeDelaysMs: [0],
    });

    expect(reply.content).toBe("Recovered");
    expect(onRun).toHaveBeenCalledWith("run-2");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ run_id: "run-2", messages: request.messages });
  });

  test("requests without a run send no run id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse(`data: {"delta":"Hi"}\n\n${done(1)}`));
    vi.stubGlobal("fetch", fetchMock);

    await sendChatStream("user-1", request);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("run_id");
  });
});

describe("sendChatStream reading and retrying", () => {
  const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const finished = 'data: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  test("gives up after twenty attempts in a row without progress, counting from the last that made some", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse('data: {"delta":"a"}\n\n'))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error.message).toBe("Could not reach the model. Check your connection and try again.");
    expect(error.partialText).toBe("a");
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  test("a silent connection with no stop is reported as stalled, not cancelled", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0], stallTimeoutMs: 2 }).catch(
      (caught) => caught,
    );

    expect(error.message).toBe("The chat stream stalled before the completion marker arrived.");
    expect(error.resumable).toBe(true);
  });

  test("a zero stall timeout lets a slow first byte take as long as it needs", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(sse(`data: {"delta":"Slow"}\n\n${finished}`)), 60_000);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const reply = sendChatStream("user-1", { ...request, stallTimeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(61_000);

      await expect(reply).resolves.toMatchObject({ content: "Slow" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([500, 503, 429])("retries a %i from the API", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(status, { detail: "Try again" }))
      .mockResolvedValueOnce(sse(`data: {"delta":"Recovered"}\n\n${finished}`));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] });

    expect(reply.content).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 503 the API marks as not worth retrying ends the reply at once with its message", async () => {
    const refusal = new Response(JSON.stringify({ detail: "Web search is unavailable. Turn off Web for this reply." }), {
      status: 503,
      headers: { "content-type": "application/json", "x-aperture-retryable": "false" },
    });
    const fetchMock = vi.fn().mockResolvedValue(refusal);
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] }).catch((caught) => caught);

    expect(error.message).toBe("Web search is unavailable. Turn off Web for this reply.");
    expect(error.resumable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([400, 404, 499])("a %i refusal ends the reply at once", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(json(status, { detail: "Not allowed" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", { ...request, resumeDelaysMs: [0] }).catch((caught) => caught);

    expect(error.message).toBe("Not allowed");
    expect(error.resumable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a whole JSON reply works with or without a concealed-prompt listener", async () => {
    const completion = {
      id: "c",
      model: "model-1",
      choices: [{ index: 0, message: { role: "assistant", content: "Whole reply" } }],
      usage: {},
      concealed_prompt: "Email [EMAIL_1]",
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, completion)));
    const onConcealedPrompt = vi.fn();

    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ content: "Whole reply" });
    await sendChatStream("user-1", { ...request, onConcealedPrompt });

    expect(onConcealedPrompt).toHaveBeenCalledWith("Email [EMAIL_1]");
  });

  test("a response with no content type is refused as unsupported", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await sendChatStream("user-1", request).catch((caught) => caught);

    expect(error.message).toBe("The chat API returned an unsupported content type: unknown.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a new run counts its frames from zero and needs no run listener", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse('id: 4\ndata: {"error":"HTTP 529","retryable":true}\n\n'))
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse(`id: 1\ndata: {"delta":"Fresh"}\n\nid: 2\n${finished}`));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await sendChatStream("user-1", { ...request, runId: "run-1", newRunId: () => "run-2", resumeDelaysMs: [0] });

    expect(reply.content).toBe("Fresh");
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/\/api\/chat\/runs\/run-2\/events\?after=0$/);
  });

  test("lines ending in CRLF read the same as plain newlines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse('data: {"delta":"Hi"}\r\n\r\ndata: [DONE]\r\n\r\n')));

    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ content: "Hi" });
  });

  test("a character split across two chunks arrives whole", async () => {
    const bytes = new TextEncoder().encode(`data: {"delta":"café"}\n\n${finished}`);
    const cut = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "text/event-stream" } })));

    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ content: "café" });
  });

  test("a final marker without a trailing newline still ends the reply, and nothing after it counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse('data: {"delta":"Hi"}\n\ndata: [DONE]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ content: "Hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse('data: {"delta":"Hi"}\ndata: [DONE]\ndata: {"delta":" extra"}')));
    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ content: "Hi" });
  });

  test("an empty completion is tried again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse(finished))
      .mockResolvedValueOnce(sse(`data: {"delta":"Second try"}\n\n${finished}`));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendChatStream("user-1", { ...request, resumeDelaysMs: [0] })).resolves.toMatchObject({
      content: "Second try",
    });
  });

  test("empty frames, empty deltas, and malformed snapshots change nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse(`data:\n\ndata: {"delta":"Hi"}\n\ndata: {"delta":""}\n\ndata: {"snapshot":"nope"}\n\ndata: "text"\n\n${finished}`),
      ),
    );
    const onDelta = vi.fn();
    const onSnapshot = vi.fn();

    const reply = await sendChatStream("user-1", { ...request, onDelta, onSnapshot });

    expect(reply.content).toBe("Hi");
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  test("memory notes arrive with the completion, and default to none", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(sse('data: {"delta":"Hi"}\n\ndata: {"done":true,"memory_used":3}\n\ndata: [DONE]\n\n'))
        .mockResolvedValueOnce(sse(`data: {"delta":"Hi"}\n\n${finished}`)),
    );

    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ memoryUsed: 3 });
    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ memoryUsed: 0 });
  });

  test("a concealed prompt is shown once, needs no listener, and an empty one is ignored", async () => {
    const body = `data: {"privacy":{"concealed_prompt":""}}\n\ndata: {"privacy":{"concealed_prompt":"Call [PHONE_1]"}}\n\ndata: {"delta":"Hi"}\n\n${finished}`;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => sse(body)));
    const onConcealedPrompt = vi.fn();

    await expect(sendChatStream("user-1", request)).resolves.toMatchObject({ concealedPrompt: "Call [PHONE_1]" });
    await sendChatStream("user-1", { ...request, onConcealedPrompt });

    expect(onConcealedPrompt.mock.calls).toEqual([["Call [PHONE_1]"]]);
  });
});

describe("cancelChatRun", () => {
  test("asks the server to stop the run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "run-1", status: "stopping" })));
    vi.stubGlobal("fetch", fetchMock);

    await cancelChatRun("user-1", "run-1");

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/chat\/runs\/run-1\/cancel$/);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });
});

describe("saveChatThread", () => {
  test("never sends the browser-only syncPending flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "thread-1", messages: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveChatThread("user-1", {
      id: "thread-1",
      owner_user_id: "user-1",
      title: "T",
      model_id: "m",
      group_id: null,
      pinned: false,
      used_agent: false,
      updated_at: "now",
      messages: [],
      syncPending: true,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect("syncPending" in body).toBe(false);
    expect("id" in body).toBe(false);
  });
});

describe("sendChatStream clarifying questions", () => {
  const sse = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const questions = {
    intro: "One question first.",
    questions: [
      { id: "q1", question: "Which state?", options: [{ label: "CA" }, { label: "NY" }], multiple: false, recommended: 0 },
    ],
  };
  const finished = 'data: {"done":true,"citations":[],"usage":null}\n\ndata: [DONE]\n\n';

  test("a reply that pauses to ask ends with its questions and no text of its own", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse(
          'data: {"delta":"One question first.\\n\\n"}\n\n' +
            'data: {"activity":{"kind":"ask","questions":1}}\n\n' +
            `data: ${JSON.stringify({ questions })}\n\n${finished}`,
        ),
      ),
    );
    const activities: string[] = [];

    const reply = await sendChatStream("user-1", { ...request, onActivity: (activity) => activities.push(activity.kind) });

    expect(reply.content).toBe("");
    expect(reply.questions).toEqual(questions);
    expect(activities).toEqual(["ask"]);
  });

  test("a page that comes back to a paused reply gets the questions from the snapshot", async () => {
    const snapshot = { snapshot: { base: "", text: "One question first.", activities: [], concealed_prompt: null, questions } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(`id: 3\ndata: ${JSON.stringify(snapshot)}\n\n${finished}`)));

    const reply = await sendChatStream("user-1", { ...request, runId: "run-1", attach: true });

    expect(reply).toMatchObject({ content: "", questions });
  });

  test("questions that cannot be shown leave an ordinary reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sse(`data: {"delta":"Plain answer"}\n\ndata: {"questions":{"questions":[]}}\n\n${finished}`)),
    );

    const reply = await sendChatStream("user-1", request);

    expect(reply.content).toBe("Plain answer");
    expect(reply.questions).toBeUndefined();
  });

  test("the request says whether the assistant may stop to ask", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sse(`data: {"delta":"Hi"}\n\n${finished}`));
    vi.stubGlobal("fetch", fetchMock);

    await sendChatStream("user-1", { ...request, runtime: { clarifyMode: "ask" } });
    await sendChatStream("user-1", request);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).clarify_mode).toBe("ask");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).clarify_mode).toBeNull();
  });

  test("the request says whether the assistant may research further on its own", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sse(`data: {"delta":"Hi"}\n\n${finished}`));
    vi.stubGlobal("fetch", fetchMock);

    await sendChatStream("user-1", { ...request, runtime: { workSteps: true } });
    await sendChatStream("user-1", request);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).work_steps).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).work_steps).toBe(false);
  });
});
