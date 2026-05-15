import { openDB, type DBSchema } from "idb";
import type { CreateReviewRequest, SectionSummary, VocabCard } from "@vocab/shared";

type QueuedReview = CreateReviewRequest & { queuedAt: string; ownerUid?: string };

interface VocabDb extends DBSchema {
  sections: {
    key: string;
    value: SectionSummary;
  };
  cards: {
    key: string;
    value: VocabCard;
    indexes: { "by-section": string };
  };
  pendingReviews: {
    key: string;
    value: QueuedReview;
  };
  pendingReviewQueue: {
    key: string;
    value: QueuedReview;
  };
}

const dbPromise = openDB<VocabDb>("vocab-pwa", 3, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore("sections", { keyPath: "id" });
      const cards = db.createObjectStore("cards", { keyPath: "id" });
      cards.createIndex("by-section", "sectionId");
    }
    if (oldVersion < 2 && !db.objectStoreNames.contains("pendingReviews")) {
      db.createObjectStore("pendingReviews", { keyPath: "cardId" });
    }
    if (!db.objectStoreNames.contains("pendingReviewQueue")) {
      db.createObjectStore("pendingReviewQueue", { keyPath: "clientReviewId" });
    }
  }
});

export async function cacheSections(sections: SectionSummary[]) {
  const db = await dbPromise;
  const tx = db.transaction("sections", "readwrite");
  await Promise.all(sections.map((section) => tx.store.put(section)));
  await tx.done;
}

export async function cacheCards(cards: VocabCard[]) {
  const db = await dbPromise;
  const tx = db.transaction("cards", "readwrite");
  await Promise.all(cards.map((card) => tx.store.put(card)));
  await tx.done;
}

export async function getCachedCards(sectionId: string) {
  const db = await dbPromise;
  return db.getAllFromIndex("cards", "by-section", sectionId);
}

export async function removeCachedCard(cardId: string) {
  const db = await dbPromise;
  await db.delete("cards", cardId);
}

export async function queueReview(review: CreateReviewRequest, ownerUid?: string | null) {
  const db = await dbPromise;
  await db.put("pendingReviewQueue", { ...review, ownerUid: ownerUid ?? undefined, queuedAt: new Date().toISOString() });
}

export async function getPendingReviews(ownerUid?: string | null) {
  const db = await dbPromise;
  const [legacy, queue] = await Promise.all([
    db.objectStoreNames.contains("pendingReviews") ? db.getAll("pendingReviews") : Promise.resolve([]),
    db.getAll("pendingReviewQueue")
  ]);
  const reviews = [...legacy, ...queue]
    .map(normalizeQueuedReview)
    .filter((review) => !ownerUid || !review.ownerUid || review.ownerUid === ownerUid);
  return reviews.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function getPendingReviewCount(ownerUid?: string | null) {
  const db = await dbPromise;
  if (!ownerUid) {
    const [legacy, queue] = await Promise.all([
      db.objectStoreNames.contains("pendingReviews") ? db.count("pendingReviews") : Promise.resolve(0),
      db.count("pendingReviewQueue")
    ]);
    return legacy + queue;
  }
  return (await getPendingReviews(ownerUid)).length;
}

export async function removePendingReview(clientReviewId: string) {
  const db = await dbPromise;
  await db.delete("pendingReviewQueue", clientReviewId);
  const legacy = db.objectStoreNames.contains("pendingReviews") ? await db.getAll("pendingReviews") : [];
  const legacyReview = legacy.map(normalizeQueuedReview).find((review) => review.clientReviewId === clientReviewId);
  if (legacyReview) {
    await db.delete("pendingReviews", legacyReview.clientReviewId).catch(() => undefined);
    await db.delete("pendingReviews", legacyReview.cardId).catch(() => undefined);
  }
}

function normalizeQueuedReview(review: QueuedReview): QueuedReview {
  return {
    ...review,
    clientReviewId: review.clientReviewId || `legacy-${review.cardId}-${review.reviewedAt}`,
    queuedAt: review.queuedAt ?? new Date().toISOString()
  };
}
