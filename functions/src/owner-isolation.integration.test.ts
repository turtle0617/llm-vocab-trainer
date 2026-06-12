import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import net from "node:net";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { ReviewRating } from "@vocab/shared";
import { createInitialFsrsState, scheduleReview } from "./srs.js";
import {
  assertCardReviewable,
  createCard,
  createSection,
  deleteCard,
  deleteSection,
  getCardsPage,
  getDashboard,
  getExistingReviewByClientId,
  getSectionSummaries,
  reconcileSectionSummariesForOwner,
  writeReview
} from "./repositories.js";

const runIntegration = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("owner-scoped repository integration", () => {
  let app: App | null = null;
  let db: Firestore;

  beforeAll(async () => {
    await assertFirestoreEmulatorReachable();
    app = initializeApp({ projectId: `vocab-pwa-test-${Date.now()}` }, `owner-isolation-${Date.now()}`);
    db = getFirestore(app);
  }, 5000);

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  beforeEach(async () => {
    await clearCollection(db, "sections");
    await clearCollection(db, "cards");
    await clearCollection(db, "reviewLogs");
    await clearCollection(db, "settings");
  }, 30000);

  it("keeps dashboard, sections, and cards isolated by ownerUid", async () => {
    const userA = "user-a";
    const userB = "user-b";
    const sectionA = await createSection(db, { name: "A" }, userA);
    const sectionB = await createSection(db, { name: "B" }, userB);
    await createCard(db, { sectionId: sectionA.id, content: generatedWord("alpha") }, createInitialFsrsState(), userA);
    await createCard(db, { sectionId: sectionB.id, content: generatedWord("bravo") }, createInitialFsrsState(), userB);

    const [sectionsA, sectionsB, dashboardA, cardsAFromB] = await Promise.all([
      getSectionSummaries(db, userA),
      getSectionSummaries(db, userB),
      getDashboard(db, userA),
      getCardsPage(db, { sectionId: sectionA.id, limit: 20 }, userB)
    ]);

    expect(sectionsA.map((section) => section.name)).toEqual(["A"]);
    expect(sectionsB.map((section) => section.name)).toEqual(["B"]);
    expect(dashboardA.totals.totalCards).toBe(1);
    expect(cardsAFromB.items).toEqual([]);
  });

  it("scopes review idempotency by ownerUid", async () => {
    const userA = "user-a";
    const userB = "user-b";
    const sectionA = await createSection(db, { name: "A" }, userA);
    const sectionB = await createSection(db, { name: "B" }, userB);
    const cardA = await createCard(db, { sectionId: sectionA.id, content: generatedWord("alpha") }, createInitialFsrsState(), userA);
    const cardB = await createCard(db, { sectionId: sectionB.id, content: generatedWord("bravo") }, createInitialFsrsState(), userB);
    const reviewedAt = new Date().toISOString();
    const clientReviewId = "same-client-review-id";

    const firstDueA = await writeReviewThroughRepository(db, {
      ownerUid: userA,
      sectionId: sectionA.id,
      cardId: cardA.id,
      clientReviewId,
      reviewedAt
    });
    const duplicateDueA = await writeReviewThroughRepository(db, {
      ownerUid: userA,
      sectionId: sectionA.id,
      cardId: cardA.id,
      clientReviewId,
      reviewedAt
    });
    const firstDueB = await writeReviewThroughRepository(db, {
      ownerUid: userB,
      sectionId: sectionB.id,
      cardId: cardB.id,
      clientReviewId,
      reviewedAt
    });

    const logs = await db.collection("reviewLogs").get();
    const sectionAfterReviews = (await db.collection("sections").doc(sectionA.id).get()).data()!;
    expect(duplicateDueA).toBe(firstDueA);
    expect(firstDueB).toBeTruthy();
    expect(logs.size).toBe(2);
    expect(sectionAfterReviews.reviewedToday).toBe(1);
    expect(sectionAfterReviews.dueToday).toBe(0);
  });

  it("keeps section aggregates updated for card creates, reviews, and deletes", async () => {
    const userA = "user-a";
    const section = await createSection(db, { name: "A" }, userA);
    const card = await createCard(db, { sectionId: section.id, content: generatedWord("alpha") }, createInitialFsrsState(), userA);

    let sectionDoc = (await db.collection("sections").doc(section.id).get()).data()!;
    expect(sectionDoc.totalCards).toBe(1);
    expect(sectionDoc.dueToday).toBe(1);
    expect(sectionDoc.summaryDirty).toBe(false);

    await writeReviewThroughRepository(db, {
      ownerUid: userA,
      sectionId: section.id,
      cardId: card.id,
      clientReviewId: "aggregate-review",
      reviewedAt: new Date().toISOString()
    });

    sectionDoc = (await db.collection("sections").doc(section.id).get()).data()!;
    expect(sectionDoc.totalCards).toBe(1);
    expect(sectionDoc.dueToday).toBe(0);
    expect(sectionDoc.reviewedToday).toBe(1);
    expect(sectionDoc.lastReviewedAt).toBeTruthy();

    await deleteCard(db, { sectionId: section.id, cardId: card.id, ownerUid: userA });

    sectionDoc = (await db.collection("sections").doc(section.id).get()).data()!;
    expect(sectionDoc.totalCards).toBe(0);
    expect(sectionDoc.dueToday).toBe(0);
  });

  it("does not decrement dueToday when deleting a non-due active card", async () => {
    const userA = "user-a";
    const section = await createSection(db, { name: "A" }, userA);
    const card = await createCard(db, { sectionId: section.id, content: generatedWord("alpha") }, createInitialFsrsState(), userA);
    await db.collection("cards").doc(card.id).update({ due: "2999-01-01T00:00:00.000Z" });
    await db.collection("sections").doc(section.id).update({ dueToday: 0 });

    await deleteCard(db, { sectionId: section.id, cardId: card.id, ownerUid: userA });

    const sectionDoc = (await db.collection("sections").doc(section.id).get()).data()!;
    expect(sectionDoc.totalCards).toBe(0);
    expect(sectionDoc.dueToday).toBe(0);
  });

  it("lazy reconciles stale section summaries when sections are read", async () => {
    const userA = "user-a";
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const sectionRef = db.collection("sections").doc();
    const dueCardRef = db.collection("cards").doc();
    const futureCardRef = db.collection("cards").doc();
    await sectionRef.set({
      ownerUid: userA,
      name: "stale",
      totalCards: 0,
      dueToday: 0,
      reviewedToday: 0,
      lastReviewedAt: null,
      summaryDate: "2000-01-01",
      summaryUpdatedAt: "2000-01-01T00:00:00.000Z",
      summaryDirty: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    });
    await dueCardRef.set(cardDoc({ ownerUid: userA, sectionId: sectionRef.id, word: "due", due: "2000-01-01T00:00:00.000Z" }));
    await futureCardRef.set(cardDoc({ ownerUid: userA, sectionId: sectionRef.id, word: "future", due: "2999-01-01T00:00:00.000Z" }));
    await db.collection("reviewLogs").doc().set({
      ownerUid: userA,
      sectionId: sectionRef.id,
      cardId: dueCardRef.id,
      clientReviewId: "review-today",
      rating: ReviewRating.Good,
      reviewedAt: now,
      nextDue: "2999-01-01T00:00:00.000Z",
      scheduledDays: 1,
      elapsedDays: 0,
      log: {}
    });

    const summary = (await getSectionSummaries(db, userA))[0];
    const stored = (await sectionRef.get()).data()!;

    expect(summary).toBeTruthy();
    if (!summary) throw new Error("Expected a section summary.");
    expect(summary.totalCards).toBe(2);
    expect(summary.dueToday).toBe(1);
    expect(summary.reviewedToday).toBe(1);
    expect(stored.summaryDate).toBe(today);
    expect(stored.summaryDirty).toBe(false);
  });

  it("reconciles again when a same-day future due threshold has passed", async () => {
    const userA = "user-a";
    const sectionRef = db.collection("sections").doc();
    const cardRef = db.collection("cards").doc();
    const now = new Date();
    const beforeDue = new Date(now.getTime() - 120_000);
    const dueLater = new Date(now.getTime() - 60_000).toISOString();
    await sectionRef.set({
      ownerUid: userA,
      name: "future due",
      totalCards: 0,
      dueToday: 0,
      reviewedToday: 0,
      lastReviewedAt: null,
      nextDueAt: null,
      summaryDate: "2000-01-01",
      summaryUpdatedAt: "2000-01-01T00:00:00.000Z",
      summaryDirty: true,
      createdAt: beforeDue.toISOString(),
      updatedAt: beforeDue.toISOString(),
      archivedAt: null
    });
    await cardRef.set(cardDoc({ ownerUid: userA, sectionId: sectionRef.id, word: "later", due: dueLater }));

    const first = await reconcileSectionSummariesForOwner(db, userA, { dryRun: false, now: beforeDue });
    expect(first.changedSections).toBe(1);
    let stored = (await sectionRef.get()).data()!;
    expect(stored.dueToday).toBe(0);
    expect(stored.nextDueAt).toBe(dueLater);

    const [summary] = await getSectionSummaries(db, userA);
    stored = (await sectionRef.get()).data()!;

    expect(summary?.dueToday).toBe(1);
    expect(stored.dueToday).toBe(1);
    expect(stored.nextDueAt).toBe(null);
  });

  it("manual section summary reconciliation supports dry-run and write mode", async () => {
    const userA = "user-a";
    const now = new Date("2026-06-12T12:00:00.000Z");
    const sectionRef = db.collection("sections").doc();
    const cardRef = db.collection("cards").doc();
    await sectionRef.set({
      ownerUid: userA,
      name: "manual",
      totalCards: 0,
      dueToday: 0,
      reviewedToday: 0,
      lastReviewedAt: null,
      summaryDate: "2000-01-01",
      summaryUpdatedAt: "2000-01-01T00:00:00.000Z",
      summaryDirty: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      archivedAt: null
    });
    await cardRef.set(cardDoc({ ownerUid: userA, sectionId: sectionRef.id, word: "due", due: "2026-06-01T00:00:00.000Z" }));

    const dryRun = await reconcileSectionSummariesForOwner(db, userA, { dryRun: true, now });
    expect(dryRun.changedSections).toBe(1);
    expect(dryRun.estimatedWrites).toBe(0);
    expect((await sectionRef.get()).get("totalCards")).toBe(0);

    const write = await reconcileSectionSummariesForOwner(db, userA, { dryRun: false, now });
    expect(write.changedSections).toBe(1);
    expect(write.estimatedWrites).toBe(1);
    const stored = (await sectionRef.get()).data()!;
    expect(stored.totalCards).toBe(1);
    expect(stored.dueToday).toBe(1);
    expect(stored.summaryDirty).toBe(false);

    const secondDryRun = await reconcileSectionSummariesForOwner(db, userA, { dryRun: true, now });
    expect(secondDryRun.changedSections).toBe(0);
    expect(secondDryRun.estimatedWrites).toBe(0);
  });

  it("archives only the requesting owner's section and cards", async () => {
    const userA = "user-a";
    const userB = "user-b";
    const sectionA = await createSection(db, { name: "A" }, userA);
    const sectionB = await createSection(db, { name: "B" }, userB);
    await createCard(db, { sectionId: sectionA.id, content: generatedWord("alpha") }, createInitialFsrsState(), userA);
    await createCard(db, { sectionId: sectionB.id, content: generatedWord("bravo") }, createInitialFsrsState(), userB);

    await expect(deleteSection(db, sectionA.id, userB)).rejects.toMatchObject({ status: 404 });
    const deleted = await deleteSection(db, sectionA.id, userA);
    const [sectionsA, sectionsB, cardsB] = await Promise.all([
      getSectionSummaries(db, userA),
      getSectionSummaries(db, userB),
      getCardsPage(db, { sectionId: sectionB.id, limit: 20 }, userB)
    ]);

    expect(deleted.archivedCards).toBe(1);
    expect(sectionsA).toEqual([]);
    expect(sectionsB.map((section) => section.name)).toEqual(["B"]);
    expect(cardsB.items.map((card) => card.word)).toEqual(["bravo"]);
  });
});

async function writeReviewThroughRepository(
  db: Firestore,
  input: {
    ownerUid: string;
    sectionId: string;
    cardId: string;
    clientReviewId: string;
    reviewedAt: string;
  }
) {
  const result = await db.runTransaction(async (transaction) => {
    const existing = await getExistingReviewByClientId(db, transaction, input.clientReviewId, input.ownerUid);
    if (existing) return { due: existing.nextDue };

    const card = await assertCardReviewable(db, transaction, input.cardId, input.sectionId, input.ownerUid);
    const scheduled = scheduleReview(card.data.fsrs, ReviewRating.Good, new Date(input.reviewedAt));
    transaction.update(card.ref, {
      fsrs: scheduled.fsrs,
      due: scheduled.due,
      state: scheduled.state,
      updatedAt: input.reviewedAt
    });
    await writeReview(
      db,
      transaction,
      {
        clientReviewId: input.clientReviewId,
        cardId: input.cardId,
        sectionId: input.sectionId,
        rating: ReviewRating.Good,
        reviewedAt: input.reviewedAt
      },
      scheduled,
      input.ownerUid,
      { card: card.data, section: card.section.data }
    );
    return scheduled;
  });
  return result.due;
}

async function clearCollection(db: Firestore, collection: string) {
  const snapshot = await db.collection(collection).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

function generatedWord(word: string) {
  return {
    word,
    normalizedWord: word.toLowerCase(),
    entries: [
      {
        partOfSpeech: "noun" as const,
        zhDefinition: `${word} 的解釋`,
        enDefinition: `${word} definition`,
        examples: [{ en: `${word} example.`, zh: `${word} 例句。` }]
      }
    ]
  };
}

function cardDoc(input: { ownerUid: string; sectionId: string; word: string; due: string }) {
  const now = new Date().toISOString();
  return {
    ownerUid: input.ownerUid,
    sectionId: input.sectionId,
    word: input.word,
    normalizedWord: input.word.toLowerCase(),
    content: generatedWord(input.word),
    fsrs: createInitialFsrsState(),
    due: input.due,
    state: "review",
    createdAt: now,
    updatedAt: now,
    suspendedAt: null,
    archivedAt: null
  };
}

if (!runIntegration) {
  console.info("Skipping owner isolation integration tests. Set FIRESTORE_EMULATOR_HOST to run them.");
}

async function assertFirestoreEmulatorReachable() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const [hostname, portValue] = host.split(":");
  const port = Number(portValue);
  if (!hostname || !Number.isFinite(port)) {
    throw new Error(`Invalid FIRESTORE_EMULATOR_HOST value: ${host}`);
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: hostname, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Firestore emulator is not reachable at ${host}. Start it with npm run dev:functions first.`));
    }, 1000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Firestore emulator is not reachable at ${host}. Start it with npm run dev:functions first.`));
    });
  });
}
