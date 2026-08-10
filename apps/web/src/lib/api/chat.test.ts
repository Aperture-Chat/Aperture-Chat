import { afterEach, describe, expect, test, vi } from "vitest";
import { sendChatStream } from "./chat";
import { ChatRequestError } from "./http";


const request = {
  model: "model-1",
  messages: [{ role: "user" as const, content: "Hello" }],
};


afterEach(() => {
  vi.unstubAllGlobals();
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
});
