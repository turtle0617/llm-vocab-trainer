import type { AuthStatus } from "./auth";

export const FOREGROUND_SYNC_DEBOUNCE_MS = 1200;
export const FOREGROUND_SYNC_MIN_INTERVAL_MS = 60_000;
export const FOREGROUND_SYNC_MAX_STALENESS_MS = 5 * 60_000;

type TimerId = number;

type BackgroundSyncSchedulerOptions = {
  getAuthStatus: () => AuthStatus;
  getLastCompletedAt: () => number;
  getVisibilityState: () => DocumentVisibilityState;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => TimerId;
  clearTimeout: (timerId: TimerId) => void;
  sync: () => void;
};

export function createBackgroundSyncScheduler(options: BackgroundSyncSchedulerOptions) {
  let timer: TimerId | null = null;

  function schedule() {
    if (options.getVisibilityState() !== "visible") return;
    if (options.getAuthStatus() !== "authenticated") return;

    const elapsed = options.now() - options.getLastCompletedAt();
    if (elapsed < FOREGROUND_SYNC_MIN_INTERVAL_MS) return;
    if (timer) options.clearTimeout(timer);

    const delay = elapsed < FOREGROUND_SYNC_MAX_STALENESS_MS ? FOREGROUND_SYNC_DEBOUNCE_MS : 0;
    timer = options.setTimeout(() => {
      timer = null;
      options.sync();
    }, delay);
  }

  function dispose() {
    if (!timer) return;
    options.clearTimeout(timer);
    timer = null;
  }

  return { schedule, dispose };
}

export async function runExclusiveSync(lock: { current: boolean }, sync: () => Promise<void>) {
  if (lock.current) return false;
  lock.current = true;
  try {
    await sync();
    return true;
  } finally {
    lock.current = false;
  }
}
