import { Rating, createEmptyCard, fsrs, type Card, type Grade, type RecordLogItem, type ReviewLog } from "ts-fsrs";
import { ReviewRating } from "@vocab/shared";
import { FSRS_PARAMETERS } from "./fsrs-config.js";

const scheduler = fsrs(FSRS_PARAMETERS);

export function createInitialFsrsState() {
  return serializeCard(createEmptyCard<Card>(new Date()));
}

export function scheduleReview(fsrsState: unknown, rating: ReviewRating, reviewedAt: Date) {
  const card = deserializeCard(fsrsState);
  const scheduled = scheduler.next(card, reviewedAt, toTsFsrsRating(rating));

  return {
    fsrs: serializeCard(scheduled.card),
    log: serializeReviewLog(scheduled.log),
    due: scheduled.card.due.toISOString(),
    state: String(scheduled.card.state),
    scheduledDays: scheduled.card.scheduled_days,
    elapsedDays: scheduled.card.elapsed_days
  };
}

function toTsFsrsRating(rating: ReviewRating): Grade {
  switch (rating) {
    case ReviewRating.Again:
      return Rating.Again;
    case ReviewRating.Hard:
      return Rating.Hard;
    case ReviewRating.Good:
      return Rating.Good;
    case ReviewRating.Easy:
      return Rating.Easy;
  }
}

function serializeCard(card: Card) {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review?.toISOString() ?? null
  };
}

function deserializeCard(value: unknown): Card {
  if (!value || typeof value !== "object") throw new Error("Invalid FSRS card state.");
  const card = value as Card & { due: string; last_review?: string | null };
  return {
    ...card,
    due: new Date(card.due),
    last_review: card.last_review ? new Date(card.last_review) : undefined
  };
}

function serializeReviewLog(log: ReviewLog) {
  return {
    ...log,
    due: log.due.toISOString(),
    review: log.review.toISOString()
  };
}
