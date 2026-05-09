import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { generatedWordSchema, type GeneratedWord } from "@vocab/shared";
import { buildWordGenerationPrompt, cleanupGeneratedWord, wordGenerationJsonSchema, type PromptMessages } from "./prompt.js";

export interface LLMProvider {
  generateWord(input: {
    word: string;
    locale: "zh-TW";
    schema: typeof wordGenerationJsonSchema;
    prompt: PromptMessages;
  }): Promise<GeneratedWord>;
}

export async function generateWordWithProvider(input: { word: string; locale: "zh-TW" }): Promise<GeneratedWord> {
  const provider = createProvider();
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildWordGenerationPrompt({
      word: input.word,
      locale: input.locale,
      retryError: attempt === 0 ? undefined : lastError
    });
    try {
      const raw = await provider.generateWord({
        ...input,
        prompt,
        schema: wordGenerationJsonSchema
      });
      const parsed = generatedWordSchema.safeParse(cleanupGeneratedWord(raw));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown LLM parse error";
    }
  }

  throw new Error(`LLM output did not match schema. ${lastError}`);
}

function createProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER ?? "openrouter";
  if (provider === "groq") return new OpenAiCompatibleProvider("https://api.groq.com/openai/v1/chat/completions", "groq");
  if (provider === "gemini") return new GeminiProvider();
  return new OpenAiCompatibleProvider("https://openrouter.ai/api/v1/chat/completions", "openrouter");
}

class OpenAiCompatibleProvider implements LLMProvider {
  constructor(
    private readonly endpoint: string,
    private readonly provider: "groq" | "openrouter"
  ) {}

  async generateWord(input: {
    schema: typeof wordGenerationJsonSchema;
    prompt: PromptMessages;
  }): Promise<GeneratedWord> {
    const apiKey = requireApiKey();
    const model = process.env.LLM_MODEL ?? "meta-llama/llama-4-maverick:free";
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/open-source/vocab-pwa",
        "X-Title": "vocab-pwa"
      },
      body: JSON.stringify({
        model,
        messages: input.prompt.messages,
        temperature: 0.2,
        response_format: this.responseFormat(model, input.schema)
      })
    });

    const responseBody = await response.text();
    logLlmDebug({
      provider: this.provider,
      model,
      status: response.status,
      body: responseBody
    });

    if (!response.ok) throw new Error(`LLM provider failed with ${response.status}: ${responseBody}`);
    const json = JSON.parse(responseBody) as any;
    const content = json.choices?.[0]?.message?.content;
    return parseJsonContent(content);
  }

  private responseFormat(model: string, schema: typeof wordGenerationJsonSchema) {
    if (this.provider === "groq") {
      if (model === "meta-llama/llama-4-scout-17b-16e-instruct") {
        return {
          type: "json_schema",
          json_schema: {
            name: "generated_word",
            strict: false,
            schema
          }
        };
      }

      return { type: "json_object" };
    }

    return {
      type: "json_schema",
      json_schema: {
        name: "generated_word",
        strict: true,
        schema
      }
    };
  }
}

function logLlmDebug(payload: { provider: string; model: string; status: number; body: string }) {
  if (process.env.LLM_DEBUG_LOGS !== "true") return;
  console.info(
    "[llm:response]",
    JSON.stringify({
      provider: payload.provider,
      model: payload.model,
      status: payload.status,
      body: safeTruncate(payload.body, 8000)
    })
  );
}

function safeTruncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated>` : value;
}

class GeminiProvider implements LLMProvider {
  async generateWord(input: { prompt: PromptMessages }): Promise<GeneratedWord> {
    const apiKey = requireApiKey();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.LLM_MODEL ?? "gemini-2.0-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(wordGenerationJsonSchema) as any
      }
    });
    const response = await model.generateContent(input.prompt.messages.map((message) => message.content).join("\n\n"));
    return parseJsonContent(response.response.text());
  }
}

function parseJsonContent(content: unknown): GeneratedWord {
  if (typeof content !== "string") throw new Error("LLM returned empty content.");
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed) as GeneratedWord;
}

function requireApiKey() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is not configured.");
  return apiKey;
}

function toGeminiSchema(_schema: typeof wordGenerationJsonSchema) {
  return {
    type: SchemaType.OBJECT,
    properties: {
      word: { type: SchemaType.STRING },
      normalizedWord: { type: SchemaType.STRING },
      entries: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            partOfSpeech: {
              type: SchemaType.STRING,
              enum: [
                "noun",
                "verb",
                "adjective",
                "adverb",
                "preposition",
                "conjunction",
                "interjection",
                "phrase",
                "other"
              ]
            },
            zhDefinition: { type: SchemaType.STRING },
            enDefinition: { type: SchemaType.STRING },
            examples: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  en: { type: SchemaType.STRING },
                  zh: { type: SchemaType.STRING }
                },
                required: ["en", "zh"]
              }
            }
          },
          required: ["partOfSpeech", "zhDefinition", "enDefinition", "examples"]
        }
      }
    },
    required: ["word", "normalizedWord", "entries"]
  };
}
