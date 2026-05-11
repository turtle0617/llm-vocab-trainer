import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const verifyIdToken = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken })
}));

describe("auth middleware", () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
    process.env.ALLOWED_USER_UID = "allowed-user";
    delete process.env.AUTH_DISABLED_FOR_DEV;
    delete process.env.FUNCTIONS_EMULATOR;
  });

  it("rejects requests without a bearer token", async () => {
    const { authMiddleware } = await import("./auth.js");
    const next = vi.fn();

    authMiddleware(req(), res(), next);
    await flushPromises();

    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });

  it("rejects invalid or expired tokens", async () => {
    verifyIdToken.mockRejectedValue(new Error("expired"));
    const { authMiddleware } = await import("./auth.js");
    const next = vi.fn();

    authMiddleware(req("Bearer expired"), res(), next);
    await flushPromises();

    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });

  it("rejects valid tokens from the wrong user", async () => {
    verifyIdToken.mockResolvedValue({ uid: "other-user" });
    const { authMiddleware } = await import("./auth.js");
    const next = vi.fn();

    authMiddleware(req("Bearer valid"), res(), next);
    await flushPromises();

    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });

  it("attaches auth context for the allowed user", async () => {
    verifyIdToken.mockResolvedValue({ uid: "allowed-user" });
    const { authMiddleware } = await import("./auth.js");
    const response = res();
    const next = vi.fn();

    authMiddleware(req("Bearer valid"), response, next);
    await flushPromises();

    expect(response.locals.auth).toEqual({ uid: "allowed-user" });
    expect(next).toHaveBeenCalledWith();
  });
});

function req(authorization?: string) {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined)
  } as Request;
}

function res() {
  return { locals: {} } as Response;
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
