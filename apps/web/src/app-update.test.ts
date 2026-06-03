import { beforeEach, describe, expect, it, vi } from "vitest";

const pwaMock = vi.hoisted(() => ({
  registerSW: vi.fn()
}));

vi.mock("virtual:pwa-register", () => pwaMock);

describe("app update controller", () => {
  beforeEach(() => {
    pwaMock.registerSW.mockReset();
  });

  it("checks for service worker updates without applying them", async () => {
    const update = vi.fn();
    const updateServiceWorker = vi.fn();
    pwaMock.registerSW.mockImplementation((options) => {
      options.onRegisteredSW("/sw.js", { update });
      return updateServiceWorker;
    });
    const { createAppUpdateController } = await import("./app-update");

    const controller = createAppUpdateController({ onNeedRefresh: vi.fn() });
    await controller.checkForUpdate();

    expect(pwaMock.registerSW).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it("applies a waiting update only when requested", async () => {
    const updateServiceWorker = vi.fn();
    pwaMock.registerSW.mockReturnValue(updateServiceWorker);
    const { createAppUpdateController } = await import("./app-update");

    const controller = createAppUpdateController({ onNeedRefresh: vi.fn() });
    await controller.applyUpdate();

    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });
});
