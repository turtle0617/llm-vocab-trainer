import { FieldValue, type DocumentData, type Firestore, type Transaction } from "firebase-admin/firestore";
import {
  desiredRetentionByIntensity,
  type AppSettings,
  type CreateCardRequest,
  type CreateReviewRequest,
  type CreateSectionRequest,
  type DashboardResponse,
  type ReviewIntensity,
  type SectionSummary,
  type VocabCard
} from "@vocab/shared";
import { decodeCursor, encodeCursor } from "./pagination.js";

const settingsDocId = "global";
const defaultReviewIntensity: ReviewIntensity = "standard";

export async function createSection(db: Firestore, body: CreateSectionRequest): Promise<SectionSummary> {
  const now = new Date().toISOString();
  const ref = db.collection("sections").doc();
  const section = {
    name: body.name,
    description: body.description ?? null,
    totalCards: 0,
    dueToday: 0,
    reviewedToday: 0,
    lastReviewedAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };
  await ref.set(section);
  return mapSection(ref.id, section);
}

export async function getSectionSummaries(db: Firestore): Promise<SectionSummary[]> {
  const snapshot = await db
    .collection("sections")
    .where("archivedAt", "==", null)
    .orderBy("createdAt", "desc")
    .get();
  return Promise.all(snapshot.docs.map(async (doc) => hydrateSectionSummary(db, doc.id, doc.data())));
}

export async function getDashboard(db: Firestore): Promise<DashboardResponse> {
  const sections = await getSectionSummaries(db);
  const totalCards = sections.reduce((sum, section) => sum + section.totalCards, 0);
  const dueToday = sections.reduce((sum, section) => sum + section.dueToday, 0);
  const reviewedToday = sections.reduce((sum, section) => sum + section.reviewedToday, 0);
  const reviewTrend = await getReviewTrend(db);

  return {
    totals: {
      dueToday,
      reviewedToday,
      streakDays: calculateStreak(reviewTrend),
      totalCards
    },
    reviewTrend,
    sections
  };
}

export async function getSettings(db: Firestore): Promise<AppSettings> {
  const snapshot = await db.collection("settings").doc(settingsDocId).get();
  if (!snapshot.exists) return createSettings(defaultReviewIntensity, new Date().toISOString());

  const data = snapshot.data() ?? {};
  const reviewIntensity = isReviewIntensity(data.reviewIntensity) ? data.reviewIntensity : defaultReviewIntensity;
  return createSettings(reviewIntensity, data.updatedAt ?? new Date().toISOString());
}

export async function updateSettings(db: Firestore, reviewIntensity: ReviewIntensity): Promise<AppSettings> {
  const settings = createSettings(reviewIntensity, new Date().toISOString());
  await db.collection("settings").doc(settingsDocId).set(settings, { merge: true });
  return settings;
}

export async function createCard(db: Firestore, body: CreateCardRequest, fsrs: unknown) {
  const now = new Date().toISOString();
  const due = now;
  const ref = db.collection("cards").doc();
  await db.runTransaction(async (transaction) => {
    transaction.set(ref, {
      sectionId: body.sectionId,
      word: body.content.word,
      normalizedWord: body.content.normalizedWord,
      content: body.content,
      fsrs,
      due,
      state: "new",
      createdAt: now,
      updatedAt: now,
      suspendedAt: null
    });
    transaction.update(db.collection("sections").doc(body.sectionId), {
      totalCards: FieldValue.increment(1),
      dueToday: FieldValue.increment(1),
      updatedAt: now
    });
  });
  return { id: ref.id };
}

export async function deleteSection(db: Firestore, sectionId: string) {
  const now = new Date().toISOString();
  const ref = db.collection("sections").doc(sectionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Section was not found.");
  await ref.update({ archivedAt: now, updatedAt: now });
  return { id: sectionId, archivedAt: now };
}

export async function deleteCard(db: Firestore, input: { sectionId: string; cardId: string }) {
  await db.runTransaction(async (transaction) => {
    const ref = db.collection("cards").doc(input.cardId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error("Card was not found.");

    const card = snapshot.data()!;
    if (card.sectionId !== input.sectionId) throw new Error("Card does not belong to section.");

    transaction.delete(ref);
    transaction.update(db.collection("sections").doc(input.sectionId), {
      totalCards: FieldValue.increment(-1),
      updatedAt: new Date().toISOString()
    });
  });
  return { id: input.cardId };
}

export async function getCardsPage(
  db: Firestore,
  query: { sectionId: string; dueBefore?: string; limit: number; cursor?: string }
) {
  let ref = db
    .collection("cards")
    .where("sectionId", "==", query.sectionId)
    .where("suspendedAt", "==", null)
    .orderBy("due", "asc")
    .orderBy("createdAt", "asc")
    .orderBy("__name__", "asc");

  if (query.dueBefore) ref = ref.where("due", "<=", query.dueBefore);
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    ref = ref.startAfter(cursor.due, cursor.createdAt, cursor.cardId);
  }

  const snapshot = await ref.limit(query.limit + 1).get();
  const docs = snapshot.docs.slice(0, query.limit);
  const last = docs.at(-1);

  return {
    items: docs.map((doc) => mapCard(doc.id, doc.data())),
    nextCursor:
      snapshot.docs.length > query.limit && last
        ? encodeCursor({ due: last.get("due"), createdAt: last.get("createdAt"), cardId: last.id })
        : null,
    hasMore: snapshot.docs.length > query.limit
  };
}

export async function writeReview(
  db: Firestore,
  transaction: Transaction,
  body: CreateReviewRequest,
  scheduled: {
    log: unknown;
    scheduledDays: number;
    elapsedDays: number;
  }
) {
  const reviewedAt = body.reviewedAt;
  transaction.set(db.collection("reviewLogs").doc(), {
    sectionId: body.sectionId,
    cardId: body.cardId,
    rating: body.rating,
    reviewedAt,
    scheduledDays: scheduled.scheduledDays,
    elapsedDays: scheduled.elapsedDays,
    log: scheduled.log
  });
  transaction.update(db.collection("sections").doc(body.sectionId), {
    reviewedToday: increment(1),
    lastReviewedAt: reviewedAt,
    updatedAt: new Date().toISOString()
  });
}

function mapSection(id: string, data: DocumentData): SectionSummary {
  return {
    id,
    name: data.name,
    description: data.description ?? undefined,
    totalCards: data.totalCards ?? 0,
    dueToday: data.dueToday ?? 0,
    reviewedToday: data.reviewedToday ?? 0,
    lastReviewedAt: data.lastReviewedAt ?? undefined,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

async function hydrateSectionSummary(db: Firestore, id: string, data: DocumentData): Promise<SectionSummary> {
  const now = new Date().toISOString();
  const today = `${now.slice(0, 10)}T00:00:00.000Z`;
  const [totalCards, dueToday, reviewedToday] = await Promise.all([
    db.collection("cards").where("sectionId", "==", id).count().get(),
    db.collection("cards").where("sectionId", "==", id).where("due", "<=", now).count().get(),
    db.collection("reviewLogs").where("sectionId", "==", id).where("reviewedAt", ">=", today).count().get()
  ]);

  return {
    ...mapSection(id, data),
    totalCards: totalCards.data().count,
    dueToday: dueToday.data().count,
    reviewedToday: reviewedToday.data().count
  };
}

function mapCard(id: string, data: DocumentData): VocabCard {
  return {
    id,
    sectionId: data.sectionId,
    word: data.word,
    normalizedWord: data.normalizedWord,
    content: data.content,
    due: data.due,
    state: data.state,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    suspendedAt: data.suspendedAt ?? undefined
  };
}

async function getReviewTrend(db: Firestore) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const start = `${days[0]}T00:00:00.000Z`;
  const snapshot = await db.collection("reviewLogs").where("reviewedAt", ">=", start).get();
  const counts = new Map(days.map((day) => [day, 0]));
  snapshot.docs.forEach((doc) => {
    const day = String(doc.get("reviewedAt")).slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  });
  return days.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

function calculateStreak(trend: Array<{ date: string; count: number }>) {
  let streak = 0;
  for (const day of [...trend].reverse()) {
    if (day.count === 0) break;
    streak += 1;
  }
  return streak;
}

function increment(value: number) {
  return FieldValue.increment(value);
}

function createSettings(reviewIntensity: ReviewIntensity, updatedAt: string): AppSettings {
  return {
    reviewIntensity,
    desiredRetention: desiredRetentionByIntensity[reviewIntensity],
    updatedAt
  };
}

function isReviewIntensity(value: unknown): value is ReviewIntensity {
  return value === "relaxed" || value === "standard" || value === "solid" || value === "exam";
}
