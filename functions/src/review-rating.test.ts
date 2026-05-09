import { describe, expect, it } from "vitest";
import { ReviewRating, assertValidReviewRating } from "@vocab/shared";

describe("review rating contract", () => {
  it("uses numeric fsrs-compatible values", () => {
    expect(assertValidReviewRating(ReviewRating.Again)).toBe(1);
    expect(assertValidReviewRating(ReviewRating.Hard)).toBe(2);
    expect(assertValidReviewRating(ReviewRating.Good)).toBe(3);
    expect(assertValidReviewRating(ReviewRating.Easy)).toBe(4);
  });
});
