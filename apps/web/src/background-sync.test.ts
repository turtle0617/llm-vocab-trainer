import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOREGROUND_SYNC_DEBOUNCE_MS,
  FOREGROUND_SYNC_MAX_STALENESS_MS,
  FOREGROUND_SYNC_MIN_INTERVAL_MS,
  createBackgroundSyncScheduler,
  createForegroundTrigger,
  runExclusiveSync
} from "./background-sync";
import type { AuthStatus } from "./auth";

describe("background sync scheduling", () => {
  let authStatus: AuthStatus;
  let lastCompletedAt: number;
  let now: number;
  let visibilityState: DocumentVisibilityState;
  let nextTimerId: number;
  let timers: Array<{ id: number; callback: () => void; delay: number; cleared: boolean }>;
  let sync: ReturnType<typeof vi.fn>;
  let clearTimeoutMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authStatus = "authenticated";
    lastCompletedAt = 1_000_000;
    now = lastCompletedAt + FOREGROUND_SYNC_MIN_INTERVAL_MS + 1;
    visibilityState = "visible";
    nextTimerId = 1;
    timers = [];
    sync = vi.fn();
    clearTimeoutMock = vi.fn((timerId: number) => {
      const timer = timers.find((item) => item.id === timerId);
      if (timer) timer.cleared = true;
    });
  });

  it("does not sync when focus happens inside the cooldown window", () => {
    now = lastCompletedAt + FOREGROUND_SYNC_MIN_INTERVAL_MS - 1;
    const scheduler = createTestScheduler();

    scheduler.schedule();

    expect(timers).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });

  it("debounces focus, visibilitychange, and online into one background sync", () => {
    const scheduler = createTestScheduler();

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    expect(timers.map((timer) => timer.delay)).toEqual([
      FOREGROUND_SYNC_DEBOUNCE_MS,
      FOREGROUND_SYNC_DEBOUNCE_MS,
      FOREGROUND_SYNC_DEBOUNCE_MS
    ]);
    expect(clearTimeoutMock).toHaveBeenNthCalledWith(1, 1);
    expect(clearTimeoutMock).toHaveBeenNthCalledWith(2, 2);

    fireTimer(1);
    fireTimer(2);
    fireTimer(3);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("runs immediately when the last sync is stale", () => {
    now = lastCompletedAt + FOREGROUND_SYNC_MAX_STALENESS_MS + 1;
    const scheduler = createTestScheduler();

    scheduler.schedule();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(0);
    fireTimer(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("skips scheduling when the page is hidden or the user is not authenticated", () => {
    visibilityState = "hidden";
    const hiddenScheduler = createTestScheduler();
    hiddenScheduler.schedule();

    authStatus = "requiresLogin";
    visibilityState = "visible";
    const signedOutScheduler = createTestScheduler();
    signedOutScheduler.schedule();

    expect(timers).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });

  it("clears a pending debounce timer on dispose", () => {
    const scheduler = createTestScheduler();

    scheduler.schedule();
    scheduler.dispose();
    fireTimer(1);

    expect(clearTimeoutMock).toHaveBeenCalledWith(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it("returns immediately while a sync is already in progress", async () => {
    const lock = { current: false };
    let releaseFirstSync!: () => void;
    const firstSync = runExclusiveSync(
      lock,
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSync = resolve;
        })
    );

    await expect(runExclusiveSync(lock, vi.fn())).resolves.toBe(false);

    releaseFirstSync();
    await expect(firstSync).resolves.toBe(true);
    expect(lock.current).toBe(false);
  });

  it("fans out foreground events to independent sync and update callbacks", () => {
    const syncScheduler = createTestScheduler();
    const checkForUpdate = vi.fn();
    const foreground = createTestForegroundTrigger(() => {
      syncScheduler.schedule();
      checkForUpdate();
    });

    foreground.fireWindowEvent("focus");
    fireTimer(1);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    foreground.dispose();
  });

  it("continues update checks when sync scheduling is auth-gated", () => {
    authStatus = "anonymous";
    const syncScheduler = createTestScheduler();
    const checkForUpdate = vi.fn();
    const foreground = createTestForegroundTrigger(() => {
      syncScheduler.schedule();
      checkForUpdate();
    });

    foreground.fireWindowEvent("online");

    expect(sync).not.toHaveBeenCalled();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    foreground.dispose();
  });

  it("does not couple update check failures to sync scheduling", () => {
    const syncScheduler = createTestScheduler();
    const checkForUpdate = vi.fn(() => {
      throw new Error("update unavailable");
    });
    const foreground = createTestForegroundTrigger(() => {
      syncScheduler.schedule();
      try {
        checkForUpdate();
      } catch {
        // The app update path handles its own failures and keeps sync scheduling independent.
      }
    });

    foreground.fireDocumentEvent("visibilitychange");
    fireTimer(1);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    foreground.dispose();
  });

  function createTestScheduler() {
    return createBackgroundSyncScheduler({
      clearTimeout: clearTimeoutMock,
      getAuthStatus: () => authStatus,
      getLastCompletedAt: () => lastCompletedAt,
      getVisibilityState: () => visibilityState,
      now: () => now,
      setTimeout: (callback, delay) => {
        const id = nextTimerId++;
        timers.push({ id, callback, delay, cleared: false });
        return id;
      },
      sync
    });
  }

  function fireTimer(id: number) {
    const timer = timers.find((item) => item.id === id);
    if (timer && !timer.cleared) timer.callback();
  }

  function createTestForegroundTrigger(onForeground: () => void) {
    const windowListeners = new Map<string, () => void>();
    const documentListeners = new Map<string, () => void>();
    const trigger = createForegroundTrigger({
      addDocumentListener: vi.fn((event, callback) => {
        documentListeners.set(event, callback as () => void);
      }) as unknown as typeof document.addEventListener,
      addWindowListener: vi.fn((event, callback) => {
        windowListeners.set(event, callback as () => void);
      }) as unknown as typeof window.addEventListener,
      onForeground,
      removeDocumentListener: vi.fn((event) => {
        documentListeners.delete(event);
      }) as unknown as typeof document.removeEventListener,
      removeWindowListener: vi.fn((event) => {
        windowListeners.delete(event);
      }) as unknown as typeof window.removeEventListener
    });

    function fireWindowEvent(event: string) {
      windowListeners.get(event)?.();
    }

    function fireDocumentEvent(event: string) {
      documentListeners.get(event)?.();
    }

    return {
      dispose: trigger.dispose,
      fireWindowEvent,
      fireDocumentEvent
    };
  }
});
