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

const dbPromise = openDB<VocabDb>("vocab-pwa", 1, {
  upgrade(db) {
    db.createObjectStore("sections", { keyPath: "id" });
    const cards = db.createObjectStore("cards", { keyPath: "id" });
    cards.createIndex("by-section", "sectionId");
    db.createObjectStore("pendingReviews", { keyPath: "cardId" });
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

export async function queueReview(review: CreateReviewRequest) {
  const db = await dbPromise;
  await db.put("pendingReviews", { ...review, queuedAt: new Date().toISOString() });
}

export async function getPendingReviews() {
  const db = await dbPromise;
  return db.getAll("pendingReviews");
}

export async function removePendingReview(cardId: string) {
  const db = await dbPromise;
  await db.delete("pendingReviews", cardId);
}
