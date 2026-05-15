import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRating } from "@vocab/shared";

const authMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getCurrentUserUid: vi.fn()
}));
const apiMock = vi.hoisted(() => ({
  ApiAuthError: class ApiAuthError extends Error {},
  api: {
    review: vi.fn()
  }
}));
const offlineMock = vi.hoisted(() => ({
  getPendingReviews: vi.fn(),
  removePendingReview: vi.fn()
}));

vi.mock("./auth", () => authMock);
vi.mock("./api", () => apiMock);
vi.mock("./offline", () => offlineMock);

describe("pending review sync", () => {
  beforeEach(() => {
    authMock.getAuthStatus.mockReturnValue("authenticated");
    authMock.getCurrentUserUid.mockReturnValue("user-a");
    apiMock.api.review.mockReset();
    offlineMock.getPendingReviews.mockReset();
    offlineMock.removePendingReview.mockReset();
  });

  it("skips syncing when the user is not authenticated", async () => {
    authMock.getAuthStatus.mockReturnValue("requiresLogin");
    const { syncPendingReviews } = await import("./sync");

    await expect(syncPendingReviews()).resolves.toEqual({ status: "skipped", synced: 0 });

    expect(offlineMock.getPendingReviews).not.toHaveBeenCalled();
  });

  it("skips syncing when the current user id is unavailable", async () => {
    authMock.getCurrentUserUid.mockReturnValue(null);
    const { syncPendingReviews } = await import("./sync");

    await expect(syncPendingReviews()).resolves.toEqual({ status: "skipped", synced: 0 });

    expect(offlineMock.getPendingReviews).not.toHaveBeenCalled();
  });

  it("syncs pending reviews in queue order and removes successful items", async () => {
    const reviews = [pending("review-1"), pending("review-2")];
    offlineMock.getPendingReviews.mockResolvedValue(reviews);
    apiMock.api.review.mockResolvedValue({ nextDue: "2026-05-10T00:00:00.000Z" });
    const { syncPendingReviews } = await import("./sync");

    await expect(syncPendingReviews()).resolves.toEqual({ status: "complete", synced: 2 });

    expect(offlineMock.getPendingReviews).toHaveBeenCalledWith("user-a");
    expect(apiMock.api.review).toHaveBeenNthCalledWith(1, {
      clientReviewId: "review-1",
      cardId: "card-1",
      sectionId: "section-1",
      rating: ReviewRating.Good,
      reviewedAt: "2026-05-10T00:00:00.000Z"
    });
    expect(apiMock.api.review).toHaveBeenNthCalledWith(2, {
      clientReviewId: "review-2",
      cardId: "card-1",
      sectionId: "section-1",
      rating: ReviewRating.Good,
      reviewedAt: "2026-05-10T00:00:00.000Z"
    });
    expect(offlineMock.removePendingReview).toHaveBeenNthCalledWith(1, "review-1");
    expect(offlineMock.removePendingReview).toHaveBeenNthCalledWith(2, "review-2");
  });

  it("keeps unsynced items after the first failure", async () => {
    const reviews = [pending("review-1"), pending("review-2")];
    const error = new Error("offline");
    offlineMock.getPendingReviews.mockResolvedValue(reviews);
    apiMock.api.review.mockResolvedValueOnce({ nextDue: "2026-05-10T00:00:00.000Z" }).mockRejectedValueOnce(error);
    const { syncPendingReviews } = await import("./sync");

    await expect(syncPendingReviews()).resolves.toEqual({ status: "partial", synced: 1, error });

    expect(offlineMock.removePendingReview).toHaveBeenCalledTimes(1);
    expect(offlineMock.removePendingReview).toHaveBeenCalledWith("review-1");
  });
});

function pending(clientReviewId: string) {
  return {
    clientReviewId,
    cardId: "card-1",
    sectionId: "section-1",
    rating: ReviewRating.Good,
    reviewedAt: "2026-05-10T00:00:00.000Z",
    queuedAt: `2026-05-10T00:00:0${clientReviewId.at(-1)}.000Z`,
    ownerUid: "user-a"
  };
}
