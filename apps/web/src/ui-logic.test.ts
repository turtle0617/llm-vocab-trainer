import { describe, expect, it } from "vitest";
import type { DashboardResponse, VocabCard } from "@vocab/shared";
import {
  formatScheduledFeedback,
  getCardDueStatus,
  getDashboardAction,
  reviewIntensityPresets
} from "./ui-logic";

function dashboard(totals: DashboardResponse["totals"]): DashboardResponse {
  return {
    totals,
    reviewTrend: [],
    sections: []
  };
}

describe("ui logic", () => {
  it("chooses dashboard actions from review state", () => {
    expect(
      getDashboardAction(dashboard({ dueToday: 3, reviewedToday: 0, streakDays: 0, totalCards: 10 })).kind
    ).toBe("review");
    expect(
      getDashboardAction(dashboard({ dueToday: 0, reviewedToday: 0, streakDays: 0, totalCards: 0 })).kind
    ).toBe("add");
    expect(
      getDashboardAction(dashboard({ dueToday: 0, reviewedToday: 4, streakDays: 2, totalCards: 10 })).kind
    ).toBe("done");
  });

  it("exposes understandable review intensity presets", () => {
    expect(reviewIntensityPresets.map((preset) => preset.retention)).toEqual([0.85, 0.9, 0.93, 0.95]);
  });

  it("formats due status and scheduled feedback", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const base = {
      id: "card",
      sectionId: "section",
      word: "focus",
      normalizedWord: "focus",
      content: { word: "focus", normalizedWord: "focus", entries: [] },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      suspendedAt: undefined
    } satisfies Omit<VocabCard, "due" | "state">;

    expect(getCardDueStatus({ ...base, due: now.toISOString(), state: "new" }, now)).toBe("New");
    expect(getCardDueStatus({ ...base, due: "2026-05-09T00:00:00.000Z", state: "review" }, now)).toBe("Due");
    expect(getCardDueStatus({ ...base, due: "2026-05-12T00:00:00.000Z", state: "review" }, now)).toBe("Review");
    expect(formatScheduledFeedback("2026-05-13T00:00:00.000Z", now)).toBe("已排到 3 天後");
  });
});
