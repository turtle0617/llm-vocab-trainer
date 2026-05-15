import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRating } from "@vocab/shared";

const authMock = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  markRequiresLogin: vi.fn()
}));

vi.mock("./auth", () => authMock);

describe("live API client auth", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/api");
    authMock.getIdToken.mockReset();
    authMock.markRequiresLogin.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("adds a bearer token to live requests", async () => {
    authMock.getIdToken.mockResolvedValue("token-a");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { sections: [] })));

    const { api } = await import("./api");
    await api.sections();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/sections",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-a" })
      })
    );
  });

  it("refreshes once after a 401 and retries the request", async () => {
    authMock.getIdToken.mockResolvedValueOnce("expired-token").mockResolvedValueOnce("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { message: "expired" }))
        .mockResolvedValueOnce(jsonResponse(200, { nextDue: "2026-05-10T00:00:00.000Z" }))
    );

    const { api } = await import("./api");
    await expect(
      api.review({
        clientReviewId: "review-1",
        cardId: "card-1",
        sectionId: "section-1",
        rating: ReviewRating.Good,
        reviewedAt: "2026-05-10T00:00:00.000Z"
      })
    ).resolves.toEqual({ nextDue: "2026-05-10T00:00:00.000Z" });

    expect(authMock.getIdToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.example.test/api/reviews",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
          "Content-Type": "application/json"
        })
      })
    );
  });

  it("marks auth as requiring login when refresh fails", async () => {
    authMock.getIdToken.mockResolvedValueOnce("expired-token").mockRejectedValueOnce(new Error("refresh failed"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "expired" })));

    const { ApiAuthError, api } = await import("./api");
    await expect(api.dashboard()).rejects.toBeInstanceOf(ApiAuthError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authMock.markRequiresLogin).toHaveBeenCalledTimes(1);
  });

  it("does not retry forbidden requests", async () => {
    authMock.getIdToken.mockResolvedValue("token-a");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, { message: "blocked" })));

    const { api } = await import("./api");
    await expect(api.dashboard()).rejects.toThrow("blocked");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authMock.getIdToken).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body
  };
}
