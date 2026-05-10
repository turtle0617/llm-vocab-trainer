import type { DashboardResponse, SectionSummary, VocabCard } from "@vocab/shared";

export type DashboardAction =
  | { kind: "review"; label: string; description: string }
  | { kind: "add"; label: string; description: string }
  | { kind: "done"; label: string; description: string };

export const reviewIntensityPresets = [
  {
    id: "relaxed",
    label: "輕鬆",
    retention: 0.85,
    description: "每天複習較少，適合長期維持。"
  },
  {
    id: "standard",
    label: "標準",
    retention: 0.9,
    description: "平衡記憶保持率與每日負擔。"
  },
  {
    id: "solid",
    label: "扎實",
    retention: 0.93,
    description: "複習更密集，適合重要內容。"
  },
  {
    id: "exam",
    label: "考試",
    retention: 0.95,
    description: "提高保持率，短期壓力也最高。"
  }
] as const;

export type ReviewIntensityId = (typeof reviewIntensityPresets)[number]["id"];

export function getDashboardAction(dashboard: DashboardResponse): DashboardAction {
  if (dashboard.totals.dueToday > 0) {
    return {
      kind: "review",
      label: "開始複習",
      description: `今天有 ${dashboard.totals.dueToday} 張卡片到期。`
    };
  }

  if (dashboard.totals.totalCards === 0) {
    return {
      kind: "add",
      label: "新增第一個單字",
      description: "先建立學習材料，之後 FSRS 會安排複習。"
    };
  }

  return {
    kind: "done",
    label: "新增單字",
    description: "今天到期的卡片已完成。"
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

export function formatScheduledFeedback(nextDue: string, reviewedAt = new Date()) {
  const due = new Date(nextDue);
  const diffMs = due.getTime() - reviewedAt.getTime();
  const diffDays = Math.max(0, Math.round(diffMs / 86_400_000));

  if (diffDays === 0) return "已排到今天稍後再複習";
  if (diffDays === 1) return "已排到明天";
  return `已排到 ${diffDays} 天後`;
}
