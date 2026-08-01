import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGateway } from "./helion.functions";

describe("callGateway", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("throws when GEMINI_API_KEY is not configured", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(callGateway({ foo: "bar" })).rejects.toThrow(
      "GEMINI_API_KEY not configured",
    );
  });

  it("calls the Gemini OpenAI-compatible endpoint with the API key and returns the message content", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello world" } }] }),
    });

    const result = await callGateway(
      { model: "gemini-2.5-flash" },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("throws a specific message on HTTP 429", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(
      callGateway({}, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Limite de requisições");
  });

  it("throws a specific message on HTTP 402", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => "payment required",
    });

    await expect(
      callGateway({}, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Créditos esgotados");
  });
});
