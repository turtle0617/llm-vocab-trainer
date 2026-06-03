import { registerSW } from "virtual:pwa-register";

export type AppUpdateController = {
  checkForUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
};

type AppUpdateControllerOptions = {
  onNeedRefresh: () => void;
  onOfflineReady?: () => void;
};

export function createAppUpdateController({
  onNeedRefresh,
  onOfflineReady
}: AppUpdateControllerOptions): AppUpdateController {
  let registration: ServiceWorkerRegistration | undefined;
  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh,
    onOfflineReady,
    onRegisteredSW(_swUrl, swRegistration) {
      registration = swRegistration;
    }
  });

  return {
    async checkForUpdate() {
      await registration?.update();
    },
    async applyUpdate() {
      await updateServiceWorker(true);
    }
  };
}
