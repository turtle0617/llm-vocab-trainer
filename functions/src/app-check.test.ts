import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const verifyToken = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken })
}));

describe("app check middleware", () => {
  beforeEach(() => {
    verifyToken.mockReset();
  });

  it("rejects requests without an App Check token", async () => {
    const { appCheckMiddleware } = await import("./app-check.js");
    const next = vi.fn();

    appCheckMiddleware(req(), res(), next);
    await flushPromises();

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      message: "App Check token is required.",
      status: 401
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects invalid App Check tokens", async () => {
    verifyToken.mockRejectedValue(new Error("invalid"));
    const { appCheckMiddleware } = await import("./app-check.js");
    const next = vi.fn();

    appCheckMiddleware(req("bad-token"), res(), next);
    await flushPromises();

    expect(verifyToken).toHaveBeenCalledWith("bad-token");
    expect(next.mock.calls[0]?.[0]).toMatchObject({
      message: "App Check token is invalid.",
      status: 401
    });
  });

  it("attaches App Check context for valid tokens", async () => {
    verifyToken.mockResolvedValue({ appId: "web-app-id" });
    const { appCheckMiddleware } = await import("./app-check.js");
    const response = res();
    const next = vi.fn();

    appCheckMiddleware(req("valid-token"), response, next);
    await flushPromises();

    expect(response.locals.appCheck).toEqual({ appId: "web-app-id" });
    expect(next).toHaveBeenCalledWith();
  });
});

function req(appCheckToken?: string) {
  return {
    header: (name: string) => (name.toLowerCase() === "x-firebase-appcheck" ? appCheckToken : undefined)
  } as Request;
}

function res() {
  return { locals: {} } as Response;
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
