import type { CreateSpeechRequest } from "@vocab/shared";

const GROQ_SPEECH_ENDPOINT = "https://api.groq.com/openai/v1/audio/speech";
const GROQ_SPEECH_MODEL = "canopylabs/orpheus-v1-english";

export class SpeechProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly providerCode?: string
  ) {
    super(message);
  }
}

export class SpeechConfigError extends Error {}

export async function generateSpeech(input: CreateSpeechRequest): Promise<ArrayBuffer> {
  const response = await fetch(GROQ_SPEECH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireGroqApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_SPEECH_MODEL,
      input: input.text,
      voice: input.voice,
      response_format: "wav"
    })
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const parsedError = parseGroqError(responseBody);
    throw new SpeechProviderError(
      response.status,
      parsedError?.message ?? `TTS provider failed with ${response.status}: ${safeTruncate(responseBody, 500)}`,
      parsedError?.code
    );
  }

  return response.arrayBuffer();
}

function requireGroqApiKey() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new SpeechConfigError("GROQ_API_KEY is not configured.");
  return apiKey;
}

function safeTruncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated>` : value;
}

function parseGroqError(responseBody: string) {
  try {
    const parsed = JSON.parse(responseBody) as { error?: { message?: unknown; code?: unknown } };
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
    if (!message && !code) return null;
    return { message, code };
  } catch {
    return null;
  }
}
