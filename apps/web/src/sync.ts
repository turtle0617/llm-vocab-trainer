import { ApiAuthError, api } from "./api";
import { getAuthStatus, getCurrentUserUid, isUsingMockAuth } from "./auth";
import { getPendingReviews, removePendingReview } from "./offline";

export type SyncResult =
  | { status: "skipped"; synced: number; syncedReviews: SyncedReview[] }
  | { status: "complete"; synced: number; syncedReviews: SyncedReview[] }
  | { status: "partial"; synced: number; syncedReviews: SyncedReview[]; error: unknown };

export type SyncedReview = { cardId: string; sectionId: string };

export async function syncPendingReviews(): Promise<SyncResult> {
  if (isUsingMockAuth()) return { status: "skipped", synced: 0, syncedReviews: [] };
  if (getAuthStatus() !== "authenticated") return { status: "skipped", synced: 0, syncedReviews: [] };
  const ownerUid = getCurrentUserUid();
  if (!ownerUid) return { status: "skipped", synced: 0, syncedReviews: [] };

  const pending = await getPendingReviews(ownerUid);
  const syncedReviews: SyncedReview[] = [];
  let synced = 0;

  for (const review of pending) {
    try {
      const { queuedAt: _queuedAt, ownerUid: _ownerUid, clientReviewId, ...reviewRequest } = review;
      const request = { clientReviewId, ...reviewRequest };
      await api.review(request);
      await removePendingReview(clientReviewId);
      syncedReviews.push({ cardId: review.cardId, sectionId: review.sectionId });
      synced += 1;
    } catch (error) {
      if (error instanceof ApiAuthError) return { status: "partial", synced, syncedReviews, error };
      return { status: "partial", synced, syncedReviews, error };
    }
  }

  return { status: "complete", synced, syncedReviews };
}
