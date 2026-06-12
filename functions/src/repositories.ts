import { type DocumentData, type Firestore, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import {
  desiredRetentionByIntensity,
  type AppSettings,
  type CreateCardRequest,
  type CreateReviewRequest,
  type CreateSectionRequest,
  type DashboardResponse,
  type ReviewIntensity,
  type SectionSummary,
  type SyncResponse,
  type VocabCard
} from "@vocab/shared";
import { decodeCursor, encodeCursor } from "./pagination.js";

const defaultReviewIntensity: ReviewIntensity = "standard";
const archiveBatchSize = 450;
const sectionSummaryBatchSize = 100;
const sectionSummaryReconcileConcurrency = 5;

type SectionSummaryFields = {
  totalCards: number;
  dueToday: number;
  reviewedToday: number;
  lastReviewedAt: string | null;
  nextDueAt: string | null;
  summaryDate: string;
  summaryUpdatedAt: string;
  summaryDirty: boolean;
};

type SectionSummaryReconcileResult = {
  sectionId: string;
  changed: boolean;
  before: Partial<SectionSummaryFields>;
  after: SectionSummaryFields;
  estimatedReads: number;
  estimatedWrites: number;
};

export type SectionSummaryReconcileOwnerResult = {
  dryRun: boolean;
  ownerUid: string;
  scannedSections: number;
  changedSections: number;
  estimatedReads: number;
  estimatedWrites: number;
  sections: SectionSummaryReconcileResult[];
};

export class RepositoryError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function createSection(db: Firestore, body: CreateSectionRequest, ownerUid: string): Promise<SectionSummary> {
  const now = new Date().toISOString();
  const summaryDate = getTodayUtc(now);
  const ref = db.collection("sections").doc();
  const section = {
    ownerUid,
    name: body.name,
    description: body.description ?? null,
    totalCards: 0,
    dueToday: 0,
    reviewedToday: 0,
    lastReviewedAt: null,
    nextDueAt: null,
    summaryDate,
    summaryUpdatedAt: now,
    summaryDirty: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };
  await ref.set(section);
  return mapSection(ref.id, section);
}

export async function getSectionSummaries(db: Firestore, ownerUid: string): Promise<SectionSummary[]> {
  const now = new Date();
  const snapshot = await db
    .collection("sections")
    .where("ownerUid", "==", ownerUid)
    .where("archivedAt", "==", null)
    .orderBy("createdAt", "desc")
    .get();
  return mapWithConcurrency(snapshot.docs, sectionSummaryReconcileConcurrency, async (doc) => {
    const data = doc.data();
    if (!needsSectionSummaryReconciliation(data, now)) return mapSection(doc.id, data);

    const reconciled = await reconcileSectionSummary(db, {
      current: data,
      dryRun: false,
      now,
      ownerUid,
      sectionId: doc.id
    });
    return mapSection(doc.id, { ...data, ...reconciled.after });
  });
}

export async function getDashboard(db: Firestore, ownerUid: string): Promise<DashboardResponse> {
  const sections = await getSectionSummaries(db, ownerUid);
  const totalCards = sections.reduce((sum, section) => sum + section.totalCards, 0);
  const dueToday = sections.reduce((sum, section) => sum + section.dueToday, 0);
  const reviewedToday = sections.reduce((sum, section) => sum + section.reviewedToday, 0);
  const reviewTrend = await getReviewTrend(db, ownerUid);

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

export async function getSettings(db: Firestore, ownerUid: string): Promise<AppSettings> {
  const snapshot = await db.collection("settings").doc(ownerUid).get();
  if (!snapshot.exists) return createSettings(defaultReviewIntensity, new Date().toISOString());

  const data = snapshot.data() ?? {};
  const reviewIntensity = isReviewIntensity(data.reviewIntensity) ? data.reviewIntensity : defaultReviewIntensity;
  return createSettings(reviewIntensity, data.updatedAt ?? new Date().toISOString());
}

export async function getSyncDelta(db: Firestore, ownerUid: string, since: string): Promise<SyncResponse> {
  const [dashboardChanged, settings] = await Promise.all([hasDashboardChangesSince(db, ownerUid, since), getSettings(db, ownerUid)]);
  const settingsChanged = settings.updatedAt > since;

  return {
    serverSyncedAt: new Date().toISOString(),
    ...(dashboardChanged ? { dashboard: await getDashboard(db, ownerUid) } : {}),
    ...(settingsChanged ? { settings } : {})
  };
}

export async function updateSettings(db: Firestore, reviewIntensity: ReviewIntensity, ownerUid?: string): Promise<AppSettings> {
  const settings = createSettings(reviewIntensity, new Date().toISOString());
  if (!ownerUid) throw new RepositoryError(401, "Authentication is required.");
  await db.collection("settings").doc(ownerUid).set({ ...settings, ownerUid }, { merge: true });
  return settings;
}

async function hasDashboardChangesSince(db: Firestore, ownerUid: string, since: string) {
  const [sections, cards, reviews] = await Promise.all([
    db
      .collection("sections")
      .where("ownerUid", "==", ownerUid)
      .where("updatedAt", ">", since)
      .limit(1)
      .get(),
    db
      .collection("cards")
      .where("ownerUid", "==", ownerUid)
      .where("updatedAt", ">", since)
      .limit(1)
      .get(),
    db
      .collection("reviewLogs")
      .where("ownerUid", "==", ownerUid)
      .where("reviewedAt", ">", since)
      .limit(1)
      .get()
  ]);
  return !sections.empty || !cards.empty || !reviews.empty;
}

export async function createCard(db: Firestore, body: CreateCardRequest, fsrs: unknown, ownerUid: string) {
  const now = new Date().toISOString();
  const due = now;
  const ref = db.collection("cards").doc();
  await db.runTransaction(async (transaction) => {
    const sectionRef = db.collection("sections").doc(body.sectionId);
    const sectionSnapshot = await transaction.get(sectionRef);
    if (!sectionSnapshot.exists || sectionSnapshot.get("archivedAt") || sectionSnapshot.get("ownerUid") !== ownerUid) {
      throw new RepositoryError(400, "Section is not available.");
    }
    const sectionData = sectionSnapshot.data()!;

    transaction.set(ref, {
      ownerUid,
      sectionId: body.sectionId,
      word: body.content.word,
      normalizedWord: body.content.normalizedWord,
      content: body.content,
      fsrs,
      due,
      state: "new",
      createdAt: now,
      updatedAt: now,
      suspendedAt: null,
      archivedAt: null
    });
    transaction.update(
      sectionRef,
      buildSectionSummaryPatch({
        current: sectionData,
        dueDelta: 1,
        now,
        nextDueAt: sectionData.nextDueAt ?? null,
        totalCardsDelta: 1
      })
    );
  });
  return { id: ref.id };
}

export async function deleteSection(db: Firestore, sectionId: string, ownerUid: string) {
  const now = new Date().toISOString();
  const ref = db.collection("sections").doc(sectionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new RepositoryError(404, "Section was not found.");
  if (snapshot.get("ownerUid") !== ownerUid) throw new RepositoryError(404, "Section was not found.");
  if (snapshot.get("archivedAt")) return { id: sectionId, archivedAt: snapshot.get("archivedAt") as string, archivedCards: 0 };
  await ref.update({ archivedAt: now, updatedAt: now });

  let archivedCards = 0;
  let lastCardId: string | null = null;
  while (true) {
    let query = db
      .collection("cards")
      .where("ownerUid", "==", ownerUid)
      .where("sectionId", "==", sectionId)
      .orderBy("__name__")
      .limit(archiveBatchSize)
    if (lastCardId) query = query.startAfter(lastCardId);
    const cards = await query.get();
    const activeCards = cards.docs.filter((doc) => !doc.get("archivedAt"));
    if (cards.empty) break;

    if (activeCards.length > 0) {
      const batch = db.batch();
      activeCards.forEach((doc) => {
        batch.update(doc.ref, { archivedAt: now, updatedAt: now });
      });
      await batch.commit();
      archivedCards += activeCards.length;
    }
    lastCardId = cards.docs.at(-1)?.id ?? null;
  }

  return { id: sectionId, archivedAt: now, archivedCards };
}

export async function deleteCard(db: Firestore, input: { sectionId: string; cardId: string; ownerUid: string }) {
  await db.runTransaction(async (transaction) => {
    const ref = db.collection("cards").doc(input.cardId);
    const sectionRef = db.collection("sections").doc(input.sectionId);
    const snapshot = await transaction.get(ref);
    const sectionSnapshot = await transaction.get(sectionRef);
    if (!snapshot.exists || snapshot.get("archivedAt")) throw new RepositoryError(404, "Card was not found.");

    const card = snapshot.data()!;
    if (card.ownerUid !== input.ownerUid) throw new RepositoryError(404, "Card was not found.");
    if (card.sectionId !== input.sectionId) throw new RepositoryError(400, "Card does not belong to section.");
    if (!sectionSnapshot.exists || sectionSnapshot.get("archivedAt") || sectionSnapshot.get("ownerUid") !== input.ownerUid) {
      throw new RepositoryError(404, "Section was not found.");
    }

    const now = new Date().toISOString();
    transaction.update(ref, {
      archivedAt: now,
      updatedAt: now
    });
    transaction.update(
      sectionRef,
      buildSectionSummaryPatch({
        current: sectionSnapshot.data()!,
        dueDelta: isDueAt(card.due, now) ? -1 : 0,
        now,
        nextDueAt: sectionSnapshot.get("nextDueAt") ?? null,
        totalCardsDelta: -1
      })
    );
  });
  return { id: input.cardId };
}

export async function getCardsPage(
  db: Firestore,
  query: { sectionId: string; dueBefore?: string; limit: number; cursor?: string },
  ownerUid: string
) {
  const section = await db.collection("sections").doc(query.sectionId).get();
  if (!section.exists || section.get("archivedAt") || section.get("ownerUid") !== ownerUid) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  let ref = db
    .collection("cards")
    .where("ownerUid", "==", ownerUid)
    .where("sectionId", "==", query.sectionId)
    .where("suspendedAt", "==", null)
    .where("archivedAt", "==", null)
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
  const lastRaw = snapshot.docs.slice(0, query.limit).at(-1);

  return {
    items: docs.map((doc) => mapCard(doc.id, doc.data())),
    nextCursor:
      snapshot.docs.length > query.limit && lastRaw
        ? encodeCursor({ due: lastRaw.get("due"), createdAt: lastRaw.get("createdAt"), cardId: lastRaw.id })
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
    due: string;
  },
  ownerUid: string,
  reviewContext?: { card: DocumentData; section: DocumentData }
) {
  const reviewedAt = body.reviewedAt;
  const now = new Date().toISOString();
  const sectionRef = db.collection("sections").doc(body.sectionId);
  transaction.set(db.collection("reviewLogs").doc(), {
    ownerUid,
    clientReviewId: body.clientReviewId,
    sectionId: body.sectionId,
    cardId: body.cardId,
    rating: body.rating,
    reviewedAt,
    nextDue: scheduled.due,
    scheduledDays: scheduled.scheduledDays,
    elapsedDays: scheduled.elapsedDays,
    log: scheduled.log
  });
  transaction.update(
    sectionRef,
    buildSectionSummaryPatch({
      current: reviewContext?.section,
      dueDelta:
        reviewContext?.card && isDueAt(reviewContext.card.due, reviewedAt)
          ? -1 + (isDueAt(scheduled.due, now) ? 1 : 0)
          : 0,
      lastReviewedAt: reviewedAt,
      nextDueAt: scheduled.due,
      now,
      reviewedTodayDelta: getTodayUtc(reviewedAt) === getTodayUtc(now) ? 1 : 0
    })
  );
}

export async function getExistingReviewByClientId(
  db: Firestore,
  transaction: Transaction,
  clientReviewId: string,
  ownerUid: string
) {
  const snapshot = await transaction.get(
    db.collection("reviewLogs").where("ownerUid", "==", ownerUid).where("clientReviewId", "==", clientReviewId).limit(1)
  );
  const doc = snapshot.docs[0];
  if (!doc) return null;
  return { nextDue: String(doc.get("nextDue")) };
}

export async function assertCardReviewable(
  db: Firestore,
  transaction: Transaction,
  cardId: string,
  sectionId: string,
  ownerUid: string
) {
  const cardRef = db.collection("cards").doc(cardId);
  const snapshot = await transaction.get(cardRef);
  if (!snapshot.exists || snapshot.get("archivedAt")) throw new RepositoryError(404, "Card was not found.");

  const card = snapshot.data()!;
  if (card.ownerUid !== ownerUid) throw new RepositoryError(404, "Card was not found.");
  if (card.sectionId !== sectionId) throw new RepositoryError(400, "Card does not belong to section.");

  const sectionSnapshot = await transaction.get(db.collection("sections").doc(sectionId));
  if (!sectionSnapshot.exists || sectionSnapshot.get("archivedAt") || sectionSnapshot.get("ownerUid") !== ownerUid) {
    throw new RepositoryError(404, "Section was not found.");
  }

  return { ref: cardRef, data: card, section: { ref: sectionSnapshot.ref, data: sectionSnapshot.data()! } };
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

export async function reconcileSectionSummariesForOwner(
  db: Firestore,
  ownerUid: string,
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<SectionSummaryReconcileOwnerResult> {
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? new Date();
  const sections: SectionSummaryReconcileResult[] = [];
  let scannedSections = 0;
  let estimatedReads = 0;
  let estimatedWrites = 0;
  let lastSection: QueryDocumentSnapshot<DocumentData> | null = null;

  while (true) {
    let query = db
      .collection("sections")
      .where("ownerUid", "==", ownerUid)
      .where("archivedAt", "==", null)
      .orderBy("createdAt", "desc")
      .limit(sectionSummaryBatchSize);
    if (lastSection) query = query.startAfter(lastSection);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      scannedSections += 1;
      const result = await reconcileSectionSummary(db, {
        current: doc.data(),
        dryRun,
        now,
        ownerUid,
        sectionId: doc.id
      });
      estimatedReads += result.estimatedReads;
      estimatedWrites += result.estimatedWrites;
      if (result.changed) sections.push(result);
    }

    lastSection = snapshot.docs.at(-1) ?? null;
  }

  return {
    dryRun,
    ownerUid,
    scannedSections,
    changedSections: sections.length,
    estimatedReads,
    estimatedWrites,
    sections
  };
}

async function reconcileSectionSummary(
  db: Firestore,
  input: {
    current: DocumentData;
    dryRun: boolean;
    now: Date;
    ownerUid: string;
    sectionId: string;
  }
): Promise<SectionSummaryReconcileResult> {
  const nowIso = input.now.toISOString();
  const today = getTodayUtc(input.now);
  const todayStart = `${today}T00:00:00.000Z`;
  const [totalCards, dueToday, reviewedToday, latestReview, nextDue] = await Promise.all([
    db
      .collection("cards")
      .where("ownerUid", "==", input.ownerUid)
      .where("sectionId", "==", input.sectionId)
      .where("archivedAt", "==", null)
      .count()
      .get(),
    db
      .collection("cards")
      .where("ownerUid", "==", input.ownerUid)
      .where("sectionId", "==", input.sectionId)
      .where("archivedAt", "==", null)
      .where("due", "<=", nowIso)
      .count()
      .get(),
    db
      .collection("reviewLogs")
      .where("ownerUid", "==", input.ownerUid)
      .where("sectionId", "==", input.sectionId)
      .where("reviewedAt", ">=", todayStart)
      .count()
      .get(),
    db
      .collection("reviewLogs")
      .where("ownerUid", "==", input.ownerUid)
      .where("sectionId", "==", input.sectionId)
      .orderBy("reviewedAt", "desc")
      .limit(1)
      .get(),
    db
      .collection("cards")
      .where("ownerUid", "==", input.ownerUid)
      .where("sectionId", "==", input.sectionId)
      .where("archivedAt", "==", null)
      .where("due", ">", nowIso)
      .orderBy("due", "asc")
      .limit(1)
      .get()
  ]);
  const after: SectionSummaryFields = {
    totalCards: totalCards.data().count,
    dueToday: dueToday.data().count,
    reviewedToday: reviewedToday.data().count,
    lastReviewedAt: latestReview.docs[0]?.get("reviewedAt") ?? null,
    nextDueAt: nextDue.docs[0]?.get("due") ?? null,
    summaryDate: today,
    summaryUpdatedAt: nowIso,
    summaryDirty: false
  };
  const before = getStoredSummaryFields(input.current);
  const changed = isSectionSummaryChanged(before, after);
  const estimatedReads = 1 + 5;
  const estimatedWrites = changed && !input.dryRun ? 1 : 0;

  if (changed && !input.dryRun) {
    await db.collection("sections").doc(input.sectionId).update({ ...after, updatedAt: nowIso });
  }

  return {
    sectionId: input.sectionId,
    changed,
    before,
    after,
    estimatedReads,
    estimatedWrites
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

async function getReviewTrend(db: Firestore, ownerUid: string) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const start = `${days[0]}T00:00:00.000Z`;
  const snapshot = await db.collection("reviewLogs").where("ownerUid", "==", ownerUid).where("reviewedAt", ">=", start).get();
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

function buildSectionSummaryPatch(input: {
  current?: DocumentData;
  dueDelta?: number;
  lastReviewedAt?: string;
  nextDueAt?: string | null;
  now: string;
  reviewedTodayDelta?: number;
  totalCardsDelta?: number;
}) {
  const today = getTodayUtc(input.now);
  const base = {
    summaryUpdatedAt: input.now,
    updatedAt: input.now
  };

  if (!input.current || !isSectionSummaryFresh(input.current, input.now)) {
    return {
      ...base,
      ...(input.totalCardsDelta
        ? { totalCards: clampedIncrement(toNumber(input.current?.totalCards), input.totalCardsDelta) }
        : {}),
      ...(input.lastReviewedAt ? { lastReviewedAt: latestIso(input.current?.lastReviewedAt, input.lastReviewedAt) } : {}),
      ...(input.nextDueAt !== undefined ? { nextDueAt: earliestFutureDue(input.current?.nextDueAt, input.nextDueAt, input.now) } : {}),
      summaryDate: today,
      summaryDirty: true
    };
  }

  const nextDueAt = input.nextDueAt !== undefined
    ? earliestFutureDue(input.current.nextDueAt, input.nextDueAt, input.now)
    : normalizeNullableIso(input.current.nextDueAt);

  return {
    ...base,
    totalCards: clampedIncrement(toNumber(input.current.totalCards), input.totalCardsDelta ?? 0),
    dueToday: clampedIncrement(toNumber(input.current.dueToday), input.dueDelta ?? 0),
    reviewedToday: clampedIncrement(toNumber(input.current.reviewedToday), input.reviewedTodayDelta ?? 0),
    ...(input.lastReviewedAt ? { lastReviewedAt: latestIso(input.current.lastReviewedAt, input.lastReviewedAt) } : {}),
    nextDueAt,
    summaryDate: today,
    summaryDirty: false
  };
}

function needsSectionSummaryReconciliation(data: DocumentData, now: Date) {
  return !isSectionSummaryFresh(data, now);
}

function isSectionSummaryFresh(data: DocumentData, now: Date | string) {
  return (
    typeof data.totalCards === "number" &&
    typeof data.dueToday === "number" &&
    typeof data.reviewedToday === "number" &&
    typeof data.summaryUpdatedAt === "string" &&
    typeof data.summaryDate === "string" &&
    (typeof data.nextDueAt === "string" || data.nextDueAt === null) &&
    data.summaryDate === getTodayUtc(now) &&
    !hasDueThresholdPassed(data.nextDueAt, data.summaryUpdatedAt, now) &&
    data.summaryDirty === false
  );
}

function getStoredSummaryFields(data: DocumentData): Partial<SectionSummaryFields> {
  return {
    ...(typeof data.totalCards === "number" ? { totalCards: data.totalCards } : {}),
    ...(typeof data.dueToday === "number" ? { dueToday: data.dueToday } : {}),
    ...(typeof data.reviewedToday === "number" ? { reviewedToday: data.reviewedToday } : {}),
    ...(typeof data.lastReviewedAt === "string" || data.lastReviewedAt === null ? { lastReviewedAt: data.lastReviewedAt } : {}),
    ...(typeof data.nextDueAt === "string" || data.nextDueAt === null ? { nextDueAt: data.nextDueAt } : {}),
    ...(typeof data.summaryDate === "string" ? { summaryDate: data.summaryDate } : {}),
    ...(typeof data.summaryUpdatedAt === "string" ? { summaryUpdatedAt: data.summaryUpdatedAt } : {}),
    ...(typeof data.summaryDirty === "boolean" ? { summaryDirty: data.summaryDirty } : {})
  };
}

function isSectionSummaryChanged(before: Partial<SectionSummaryFields>, after: SectionSummaryFields) {
  return (
    before.totalCards !== after.totalCards ||
    before.dueToday !== after.dueToday ||
    before.reviewedToday !== after.reviewedToday ||
    before.lastReviewedAt !== after.lastReviewedAt ||
    before.nextDueAt !== after.nextDueAt ||
    before.summaryDate !== after.summaryDate ||
    typeof before.summaryUpdatedAt !== "string" ||
    before.summaryDirty !== after.summaryDirty
  );
}

function getTodayUtc(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

function isDueAt(cardDue: unknown, timestamp: string) {
  return typeof cardDue === "string" && new Date(cardDue).getTime() <= new Date(timestamp).getTime();
}

function clampedIncrement(current: number, delta: number) {
  return Math.max(0, current + delta);
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latestIso(current: unknown, next: string) {
  if (typeof current !== "string") return next;
  return new Date(current).getTime() > new Date(next).getTime() ? current : next;
}

function hasDueThresholdPassed(nextDueAt: unknown, summaryUpdatedAt: unknown, now: Date | string) {
  if (typeof nextDueAt !== "string") return false;
  if (typeof summaryUpdatedAt !== "string") return true;
  const nextDueTime = new Date(nextDueAt).getTime();
  const summaryTime = new Date(summaryUpdatedAt).getTime();
  const nowTime = (now instanceof Date ? now : new Date(now)).getTime();
  return Number.isFinite(nextDueTime) && Number.isFinite(summaryTime) && summaryTime < nextDueTime && nextDueTime <= nowTime;
}

function earliestFutureDue(current: unknown, candidate: string | null, now: string) {
  const values = [normalizeNullableIso(current), normalizeNullableIso(candidate)].filter(
    (value): value is string => typeof value === "string" && new Date(value).getTime() > new Date(now).getTime()
  );
  if (values.length === 0) return null;
  return values.sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
}

function normalizeNullableIso(value: unknown) {
  return typeof value === "string" || value === null ? value : null;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}
