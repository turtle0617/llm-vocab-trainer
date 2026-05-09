import { describe, expect, it } from "vitest";
import {
  ReviewRating,
  assertValidReviewRating,
  generatedWordSchema,
  normalizeWordInput
} from "./index.js";

describe("shared schemas", () => {
  it("mirrors ts-fsrs numeric ratings", () => {
    expect(ReviewRating.Again).toBe(1);
    expect(ReviewRating.Hard).toBe(2);
    expect(ReviewRating.Good).toBe(3);
    expect(ReviewRating.Easy).toBe(4);
  });

  it("rejects invalid review ratings", () => {
    expect(() => assertValidReviewRating(5)).toThrow();
    expect(() => assertValidReviewRating("Good")).toThrow();
  });

  it("validates generated words", () => {
    expect(
      generatedWordSchema.parse({
        word: "focus",
        normalizedWord: "focus",
        entries: [
          {
            partOfSpeech: "noun",
            zhDefinition: "焦點；重點",
            enDefinition: "the center of interest or activity",
            examples: [{ en: "Focus on one task.", zh: "專注在一項任務上。" }]
          }
        ]
      }).word
    ).toBe("focus");
  });

  it("normalizes word input spacing", () => {
    expect(normalizeWordInput("  look   up  ")).toBe("look up");
  });
});
