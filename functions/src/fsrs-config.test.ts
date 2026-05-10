import { describe, expect, it } from "vitest";
import { FSRS_PARAMETERS, FSRS_PROJECT_CONFIG } from "./fsrs-config.js";

describe("FSRS project config", () => {
  it("uses the recommended default retention and short same-day learning steps", () => {
    expect(FSRS_PROJECT_CONFIG.desiredRetention).toBe(0.9);
    expect(FSRS_PROJECT_CONFIG.learningSteps).toEqual(["10m"]);
    expect(FSRS_PROJECT_CONFIG.relearningSteps).toEqual(["10m"]);
    expect(FSRS_PARAMETERS.request_retention).toBe(0.9);
    expect(FSRS_PARAMETERS.enable_short_term).toBe(true);
    expect(FSRS_PARAMETERS.learning_steps).toEqual(["10m"]);
    expect(FSRS_PARAMETERS.relearning_steps).toEqual(["10m"]);
  });

  it("keeps optimization and migration defaults conservative", () => {
    expect(FSRS_PROJECT_CONFIG.minReviewsForOptimization).toBe(1000);
    expect(FSRS_PROJECT_CONFIG.parameterOptimizationIntervalDays).toBe(30);
    expect(FSRS_PROJECT_CONFIG.rescheduleExistingCardsOnEnable).toBe(false);
  });
});
