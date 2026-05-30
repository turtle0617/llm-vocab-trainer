import { describe, expect, it } from "vitest";
import { buildWordGenerationPrompt, cleanupGeneratedWord } from "./prompt.js";

describe("word generation prompt", () => {
  it("constrains the model to JSON-only vocabulary output", () => {
    const prompt = buildWordGenerationPrompt({ word: "focus", locale: "zh-TW" });
    expect(prompt.messages[0]?.content).toContain("Return exactly one JSON object");
    expect(prompt.messages[1]?.content).toContain("Traditional Chinese");
    expect(prompt.messages[1]?.content).toContain("partOfSpeech must be one of");
    expect(prompt.messages[1]?.content).toContain("specific real-life context");
    expect(prompt.messages[1]?.content).toContain("not simplistic");
  });

  it("cleans and dedupes generated output", () => {
    const cleaned = cleanupGeneratedWord({
      word: " Focus ",
      normalizedWord: " Focus ",
      entries: [
        {
          partOfSpeech: "noun",
          zhDefinition: " 焦點 ",
          enDefinition: " center of interest ",
          examples: [
            { en: " Focus on this. ", zh: " 專注在這個。 " },
            { en: " Focus on this. ", zh: " 專注在這個。 " }
          ]
        }
      ]
    });

    expect(cleaned.normalizedWord).toBe("focus");
    expect(cleaned.entries[0]?.examples).toHaveLength(1);
  });
});
