import { openDB, type DBSchema } from "idb";
import type { CreateReviewRequest, SectionSummary, VocabCard } from "@vocab/shared";

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
    value: CreateReviewRequest & { queuedAt: string };
  };
}

const dbPromise = openDB<VocabDb>("vocab-pwa", 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore("sections", { keyPath: "id" });
      const cards = db.createObjectStore("cards", { keyPath: "id" });
      cards.createIndex("by-section", "sectionId");
    }
    if (db.objectStoreNames.contains("pendingReviews")) {
      db.deleteObjectStore("pendingReviews");
    }
    db.createObjectStore("pendingReviews", { keyPath: "clientReviewId" });
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

export async function queueReview(review: CreateReviewRequest) {
  const db = await dbPromise;
  await db.put("pendingReviews", { ...review, queuedAt: new Date().toISOString() });
}

export async function getPendingReviews() {
  const db = await dbPromise;
  const reviews = await db.getAll("pendingReviews");
  return reviews.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function getPendingReviewCount() {
  const db = await dbPromise;
  return db.count("pendingReviews");
}

export async function removePendingReview(clientReviewId: string) {
  const db = await dbPromise;
  await db.delete("pendingReviews", clientReviewId);
}
