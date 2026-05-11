import { describe, expect, it } from "vitest";
import {
  ReviewRating,
  assertValidReviewRating,
  desiredRetentionByIntensity,
  generatedWordSchema,
  normalizeWordInput,
  reviewIntensitySchema
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

  it("defines review intensity presets", () => {
    expect(reviewIntensitySchema.parse("standard")).toBe("standard");
    expect(() => reviewIntensitySchema.parse("intense")).toThrow();
    expect(desiredRetentionByIntensity).toEqual({
      relaxed: 0.85,
      standard: 0.9,
      solid: 0.93,
      exam: 0.95
    });
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

  it("models client generated review ids", () => {
    const request = {
      clientReviewId: "review-1",
      cardId: "card-1",
      sectionId: "section-1",
      rating: ReviewRating.Good,
      reviewedAt: "2026-05-10T00:00:00.000Z"
    };

    expect(request.clientReviewId).toBe("review-1");
  });
});
