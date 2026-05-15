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
  deleteSection,
  getCardsPage,
  getDashboard,
  getExistingReviewByClientId,
  getSectionSummaries,
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
    const reviewedAt = "2026-05-15T00:00:00.000Z";
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
    expect(duplicateDueA).toBe(firstDueA);
    expect(firstDueB).toBeTruthy();
    expect(logs.size).toBe(2);
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
      input.ownerUid
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
