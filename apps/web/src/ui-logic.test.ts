import { describe, expect, it } from "vitest";
import type { DashboardResponse, VocabCard } from "@vocab/shared";
import {
  cleanPodcastPaste,
  formatScheduledFeedback,
  getCardDueStatus,
  getCompactActionCopy,
  getDashboardAction,
  getDeckPrioritySections,
  getStatTone,
  getTrendScale,
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

  it("formats compact dashboard action copy", () => {
    expect(getCompactActionCopy(dashboard({ dueToday: 3, reviewedToday: 0, streakDays: 0, totalCards: 10 }))).toBe(
      "Review 3 due cards"
    );
    expect(getCompactActionCopy(dashboard({ dueToday: 0, reviewedToday: 0, streakDays: 0, totalCards: 0 }))).toBe(
      "Create a deck to start"
    );
    expect(getCompactActionCopy(dashboard({ dueToday: 0, reviewedToday: 2, streakDays: 3, totalCards: 10 }))).toBe(
      "Add another word"
    );
  });

  it("sorts deck rows by review priority", () => {
    const now = "2026-05-10T00:00:00.000Z";
    const sections = [
      { id: "low", name: "Low", totalCards: 50, dueToday: 0, reviewedToday: 3, createdAt: now, updatedAt: now },
      { id: "large", name: "Large", totalCards: 100, dueToday: 0, reviewedToday: 1, createdAt: now, updatedAt: now },
      { id: "due", name: "Due", totalCards: 12, dueToday: 4, reviewedToday: 0, createdAt: now, updatedAt: now },
      { id: "reviewed", name: "Reviewed", totalCards: 8, dueToday: 0, reviewedToday: 7, createdAt: now, updatedAt: now }
    ];

    expect(getDeckPrioritySections(sections).map((section) => section.id)).toEqual([
      "due",
      "reviewed",
      "low",
      "large"
    ]);
  });

  it("maps dashboard stat tones", () => {
    expect(getStatTone("dueToday")).toBe("danger");
    expect(getStatTone("reviewedToday")).toBe("success");
    expect(getStatTone("streakDays")).toBe("warning");
    expect(getStatTone("totalCards")).toBe("info");
  });

  it("exposes understandable review intensity presets", () => {
    expect(reviewIntensityPresets.map((preset) => preset.retention)).toEqual([0.85, 0.9, 0.93, 0.95]);
  });

  it("rounds trend axis to readable scale steps", () => {
    expect(getTrendScale([0, 0, 0])).toEqual({ max: 2, middle: 1 });
    expect(getTrendScale([2, 3, 5])).toEqual({ max: 10, middle: 5 });
    expect(getTrendScale([98, 101, 203])).toEqual({ max: 400, middle: 200 });
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
    expect(formatScheduledFeedback("2026-05-13T00:00:00.000Z", now)).toBe("Scheduled in 3 days");
  });

  it("cleans Apple Podcasts paste metadata", () => {
    expect(
      cleanPodcastPaste(`“Damn, dude. I can't. I'm like clutching on to every ounce of youth that I have until August.”

來自Eat Your Crust：Turning 30，2026年5月6日
https://podcasts.apple.com/tw/podcast/eat-your-crust/id1463004931?i=1000766424826&r=162
此內容可能受到著作權的保護。`)
    ).toBe("Damn, dude. I can't. I'm like clutching on to every ounce of youth that I have until August.");

    expect(cleanPodcastPaste("Keep this sentence. 來自Some Podcast：Episode https://podcasts.apple.com/tw/example")).toBe(
      "Keep this sentence."
    );
  });
});
