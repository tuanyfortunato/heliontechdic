import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callBedrock, callGemini, getProvider, callAI } from "./helion.functions";

describe("callBedrock", () => {
  it("calls Converse with system/messages/maxTokens and returns the text content", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "hello world" }] } },
    });

    const result = await callBedrock("system prompt", [{ text: "hi" }], 100, { send: sendMock });

    expect(result).toBe("hello world");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toEqual(
      expect.objectContaining({
        system: [{ text: "system prompt" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 100 },
      }),
    );
  });

  it("returns an empty string when the response has no text block", async () => {
    const sendMock = vi.fn().mockResolvedValue({ output: { message: { content: [] } } });
    const result = await callBedrock("s", [{ text: "hi" }], 100, { send: sendMock });
    expect(result).toBe("");
  });

  it("throws a friendly message on ThrottlingException", async () => {
    const err = Object.assign(new Error("Too many tokens per day"), {
      name: "ThrottlingException",
    });
    const sendMock = vi.fn().mockRejectedValue(err);

    await expect(callBedrock("s", [{ text: "hi" }], 100, { send: sendMock })).rejects.toThrow(
      "Limite de requisições",
    );
  });

  it("wraps other errors with the AWS error name", async () => {
    const err = Object.assign(new Error("boom"), { name: "ValidationException" });
    const sendMock = vi.fn().mockRejectedValue(err);

    await expect(callBedrock("s", [{ text: "hi" }], 100, { send: sendMock })).rejects.toThrow(
      "Bedrock ValidationException: boom",
    );
  });
});

describe("callGemini", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the Gemini endpoint with model/messages/max_tokens/reasoning_effort and returns the text content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "hello world" } }] }),
      text: async () => "",
    });

    const result = await callGemini(
      "system prompt",
      [{ type: "text", text: "hi" }],
      100,
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-gemini-key");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gemini-flash-latest",
      max_tokens: 100,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
  });

  it("returns an empty string when the response has no choices", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    });

    const result = await callGemini(
      "s",
      [{ type: "text", text: "hi" }],
      100,
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toBe("");
  });

  it("throws a friendly message on HTTP 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "Too many requests",
    });

    await expect(
      callGemini("s", [{ type: "text", text: "hi" }], 100, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Limite de requisições");
  });

  it("wraps other HTTP errors with the status and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "internal error",
    });

    await expect(
      callGemini("s", [{ type: "text", text: "hi" }], 100, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Gemini 500: internal error");
  });
});

describe("getProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to bedrock when AI_PROVIDER is unset", () => {
    expect(getProvider()).toBe("bedrock");
  });

  it("returns gemini when AI_PROVIDER=gemini (case-insensitive)", () => {
    vi.stubEnv("AI_PROVIDER", "Gemini");
    expect(getProvider()).toBe("gemini");
  });

  it("falls back to bedrock for unrecognized values", () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    expect(getProvider()).toBe("bedrock");
  });
});

describe("callAI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes to Bedrock by default", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "bedrock reply" }] } },
    });
    const fetchMock = vi.fn();

    const result = await callAI("system", { text: "hi" }, 100, {
      bedrockClient: { send: sendMock },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("bedrock reply");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes to Gemini when AI_PROVIDER=gemini", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const sendMock = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "gemini reply" } }] }),
      text: async () => "",
    });

    const result = await callAI("system", { text: "hi" }, 100, {
      bedrockClient: { send: sendMock },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("gemini reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("includes the image in the Bedrock content when imageDataUrl is set", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "ok" }] } },
    });

    await callAI("system", { text: "hi", imageDataUrl: "data:image/png;base64,AAAA" }, 100, {
      bedrockClient: { send: sendMock },
    });

    const command = sendMock.mock.calls[0][0];
    expect(command.input.messages[0].content).toEqual([
      { text: "hi" },
      { image: { format: "png", source: { bytes: expect.any(Uint8Array) } } },
    ]);
  });

  it("includes the image in the Gemini content when imageDataUrl is set", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      text: async () => "",
    });

    await callAI("system", { text: "hi", imageDataUrl: "data:image/png;base64,AAAA" }, 100, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
