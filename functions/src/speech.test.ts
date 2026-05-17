import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechRequestSchema } from "@vocab/shared";
import { generateSpeech, SpeechConfigError, SpeechProviderError } from "./speech.js";

describe("generateSpeech", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "groq-key";
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    vi.unstubAllGlobals();
  });

  it("calls Groq Orpheus and returns wav audio bytes", async () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => audio
      })
    );

    await expect(generateSpeech({ text: "hello", voice: "hannah" })).resolves.toBe(audio);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer groq-key",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          model: "canopylabs/orpheus-v1-english",
          input: "hello",
          voice: "hannah",
          response_format: "wav"
        })
      })
    );
  });

  it("defaults the voice to hannah", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0)
      })
    );

    await generateSpeech(createSpeechRequestSchema.parse({ text: "hello" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"voice":"hannah"')
      })
    );
  });

  it("rejects missing Groq API key", async () => {
    delete process.env.GROQ_API_KEY;

    await expect(generateSpeech({ text: "hello", voice: "hannah" })).rejects.toBeInstanceOf(SpeechConfigError);
  });

  it("rejects upstream failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "rate limited"
            }
          })
      })
    );

    await expect(generateSpeech({ text: "hello", voice: "hannah" })).rejects.toBeInstanceOf(SpeechProviderError);
    await expect(generateSpeech({ text: "hello", voice: "hannah" })).rejects.toMatchObject({
      providerCode: "rate_limit_exceeded",
      message: "rate limited"
    });
  });
});
