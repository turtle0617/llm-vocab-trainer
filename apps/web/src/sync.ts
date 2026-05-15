import { ApiAuthError, api } from "./api";
import { getAuthStatus, getCurrentUserUid } from "./auth";
import { getPendingReviews, removePendingReview } from "./offline";

export type SyncResult =
  | { status: "skipped"; synced: number }
  | { status: "complete"; synced: number }
  | { status: "partial"; synced: number; error: unknown };

export async function syncPendingReviews(): Promise<SyncResult> {
  if (getAuthStatus() !== "authenticated") return { status: "skipped", synced: 0 };
  const ownerUid = getCurrentUserUid();
  if (!ownerUid) return { status: "skipped", synced: 0 };

  const pending = await getPendingReviews(ownerUid);
  let synced = 0;

  for (const review of pending) {
    try {
      const { queuedAt: _queuedAt, ownerUid: _ownerUid, ...request } = review;
      await api.review(request);
      await removePendingReview(review.clientReviewId);
      synced += 1;
    } catch (error) {
      if (error instanceof ApiAuthError) return { status: "partial", synced, error };
      return { status: "partial", synced, error };
    }
  }

  return { status: "complete", synced };
}
