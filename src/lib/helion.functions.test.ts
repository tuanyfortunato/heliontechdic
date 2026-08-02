import { describe, it, expect, vi } from "vitest";
import { callBedrock } from "./helion.functions";

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
    const err = Object.assign(new Error("Too many tokens per day"), { name: "ThrottlingException" });
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
