import type { DashboardResponse, SectionSummary, VocabCard } from "@vocab/shared";
import { desiredRetentionByIntensity, type ReviewIntensity } from "@vocab/shared";

export type DashboardAction =
  | { kind: "review"; label: string; description: string }
  | { kind: "add"; label: string; description: string }
  | { kind: "done"; label: string; description: string };

export const reviewIntensityPresets = [
  {
    id: "relaxed",
    label: "Relaxed",
    retention: desiredRetentionByIntensity.relaxed,
    description: "Lower daily load for long-term maintenance."
  },
  {
    id: "standard",
    label: "Standard",
    retention: desiredRetentionByIntensity.standard,
    description: "Balances retention and daily review effort."
  },
  {
    id: "solid",
    label: "Solid",
    retention: desiredRetentionByIntensity.solid,
    description: "More frequent review for important material."
  },
  {
    id: "exam",
    label: "Exam",
    retention: desiredRetentionByIntensity.exam,
    description: "Higher retention target with the heaviest short-term load."
  }
] as const satisfies ReadonlyArray<{
  id: ReviewIntensity;
  label: string;
  retention: number;
  description: string;
}>;

export type ReviewIntensityId = ReviewIntensity;
export type StatTone = "danger" | "warning" | "success" | "info";

export function getDashboardAction(dashboard: DashboardResponse): DashboardAction {
  if (dashboard.totals.dueToday > 0) {
    return {
      kind: "review",
      label: "Start review",
      description: `${dashboard.totals.dueToday} ${pluralize(dashboard.totals.dueToday, "card")} ${dashboard.totals.dueToday === 1 ? "is" : "are"} due today.`
    };
  }

  if (dashboard.totals.totalCards === 0) {
    return {
      kind: "add",
      label: "Add your first word",
      description: "Create learning material first, then FSRS will schedule reviews."
    };
  }

  return {
    kind: "done",
    label: "Add word",
    description: "All due cards are done for today."
  };
}

export function getCardDueStatus(card: VocabCard, now = new Date()) {
  if (card.state === "new") return "New";
  if (new Date(card.due).getTime() <= now.getTime()) return "Due";
  return "Review";
}

export function getPrimarySection(sections: SectionSummary[]) {
  return sections.find((section) => section.dueToday > 0) ?? sections[0];
}

export function getDeckPrioritySections(sections: SectionSummary[]) {
  return [...sections].sort((a, b) => {
    const dueDelta = b.dueToday - a.dueToday;
    if (dueDelta !== 0) return dueDelta;

    const reviewedDelta = b.reviewedToday - a.reviewedToday;
    if (reviewedDelta !== 0) return reviewedDelta;

    return b.totalCards - a.totalCards;
  });
}

export function getStatTone(label: "dueToday" | "reviewedToday" | "streakDays" | "totalCards"): StatTone {
  if (label === "dueToday") return "danger";
  if (label === "reviewedToday") return "success";
  if (label === "streakDays") return "warning";
  return "info";
}

export function getCompactActionCopy(dashboard: DashboardResponse) {
  const action = getDashboardAction(dashboard);
  if (action.kind === "review") {
    return `Review ${dashboard.totals.dueToday} due ${pluralize(dashboard.totals.dueToday, "card")}`;
  }
  if (action.kind === "add" && dashboard.sections.length === 0) return "Create a deck to start";
  if (action.kind === "add") return "Generate your next card";
  return "Add another word";
}

export function getTrendScale(values: number[]) {
  const maxValue = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(maxValue));
  const normalized = maxValue / magnitude;
  const niceNormalized = normalized <= 2 ? 2 : normalized <= 4 ? 4 : 10;
  const max = niceNormalized * magnitude;

  return {
    max,
    middle: max / 2
  };
}

export function formatScheduledFeedback(nextDue: string, reviewedAt = new Date()) {
  const due = new Date(nextDue);
  const diffMs = due.getTime() - reviewedAt.getTime();
  const diffDays = Math.max(0, Math.round(diffMs / 86_400_000));

  if (diffDays === 0) return "Scheduled for later today";
  if (diffDays === 1) return "Scheduled for tomorrow";
  return `Scheduled in ${diffDays} days`;
}

export function cleanPodcastPaste(input: string) {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const contentLines: string[] = [];
  for (const line of lines) {
    if (isPodcastMetadataLine(line)) break;
    contentLines.push(line);
  }

  const content = contentLines.length > 0 ? contentLines.join(" ") : input.trim();
  return stripWrappingQuotes(
    content
      .replace(/\s+來自\S+.*$/s, "")
      .replace(/\s+https?:\/\/\S+.*$/s, "")
      .replace(/\s*此內容可能受到著作權.*$/s, "")
      .trim()
  );
}

function isPodcastMetadataLine(line: string) {
  return line.startsWith("來自") || /^https?:\/\//.test(line) || line.includes("著作權");
}

function stripWrappingQuotes(value: string) {
  return value
    .replace(/^[“”"']+/, "")
    .replace(/[“”"']+$/, "")
    .trim();
}

function pluralize(count: number, noun: string) {
  return count === 1 ? noun : `${noun}s`;
}
