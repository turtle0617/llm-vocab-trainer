import type { GeneratedWord } from "@vocab/shared";

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

export interface PromptMessages {
  messages: PromptMessage[];
}

export const wordGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["word", "normalizedWord", "entries"],
  properties: {
    word: { type: "string", minLength: 1, maxLength: 80 },
    normalizedWord: { type: "string", minLength: 1, maxLength: 80 },
    entries: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["partOfSpeech", "zhDefinition", "enDefinition", "examples"],
        properties: {
          partOfSpeech: {
            type: "string",
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
          zhDefinition: { type: "string", minLength: 1, maxLength: 500 },
          enDefinition: { type: "string", minLength: 1, maxLength: 500 },
          examples: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["en", "zh"],
              properties: {
                en: { type: "string", minLength: 1, maxLength: 240 },
                zh: { type: "string", minLength: 1, maxLength: 240 }
              }
            }
          }
        }
      }
    }
  }
} as const;

export function buildWordGenerationPrompt(input: { word: string; locale: "zh-TW"; retryError?: string }): PromptMessages {
  const repair = input.retryError
    ? `\nPrevious output failed validation. Fix these issues and return valid JSON only: ${input.retryError}`
    : "";

  return {
    messages: [
      {
        role: "system",
        content:
          "You are an English vocabulary teaching content generator for Traditional Chinese learners. Return exactly one JSON object. Do not return markdown, code fences, explanations, comments, or text outside JSON."
      },
      {
        role: "user",
        content: `Generate vocabulary study content for the English word or phrase "${input.word}".

Requirements:
- Use Traditional Chinese for zhDefinition and zh example translations.
- Use concise natural English for enDefinition and examples.
- Include only common meanings and common parts of speech.
- For each part of speech, include 1 to 3 natural bilingual example sentences.
- Write examples with a specific real-life context, useful collocations, or a common situation.
- Keep examples concise but not simplistic; aim for practical learner sentences of about 8 to 18 English words.
- Avoid overly generic examples that do not teach usage, such as "The train is late."
- Avoid rare, archaic, offensive, or likely incorrect usage.
- normalizedWord must be the lowercase lemma or normalized phrase.
- partOfSpeech must be one of: noun, verb, adjective, adverb, preposition, conjunction, interjection, phrase, other.
- The JSON object must match this TypeScript shape exactly:
{
  "word": string,
  "normalizedWord": string,
  "entries": [
    {
      "partOfSpeech": "noun" | "verb" | "adjective" | "adverb" | "preposition" | "conjunction" | "interjection" | "phrase" | "other",
      "zhDefinition": string,
      "enDefinition": string,
      "examples": [{ "en": string, "zh": string }]
    }
  ]
}${repair}`
      }
    ]
  };
}

export function cleanupGeneratedWord(word: GeneratedWord): GeneratedWord {
  const seenEntries = new Set<string>();
  return {
    word: word.word.trim(),
    normalizedWord: word.normalizedWord.trim().toLowerCase(),
    entries: word.entries
      .map((entry) => ({
        ...entry,
        zhDefinition: entry.zhDefinition.trim(),
        enDefinition: entry.enDefinition.trim(),
        examples: dedupeExamples(
          entry.examples
            .map((example) => ({ en: example.en.trim(), zh: example.zh.trim() }))
            .filter((example) => example.en && example.zh)
        ).slice(0, 3)
      }))
      .filter((entry) => entry.zhDefinition && entry.enDefinition && entry.examples.length > 0)
      .filter((entry) => {
        const key = `${entry.partOfSpeech}:${entry.zhDefinition}:${entry.enDefinition}`;
        if (seenEntries.has(key)) return false;
        seenEntries.add(key);
        return true;
      })
      .slice(0, 6)
  };
}

function dedupeExamples<T extends { en: string; zh: string }>(examples: T[]): T[] {
  const seen = new Set<string>();
  return examples.filter((example) => {
    const key = `${example.en}:${example.zh}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
