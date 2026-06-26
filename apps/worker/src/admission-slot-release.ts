import type { AdmissionHandle } from '@open-tag/scheduler';

export function createAdmissionSlotReleaser(getHandle: () => AdmissionHandle | null): {
  releaseStartSlot(): void;
  releaseRunningSlot(): void;
  releaseAll(): void;
} {
  let startSlotReleased = false;
  let runningSlotReleased = false;

  const releaseStartSlot = (): void => {
    const handle = getHandle();
    if (!handle || startSlotReleased) return;
    handle.releaseStartSlot();
    startSlotReleased = true;
  };
  const releaseRunningSlot = (): void => {
    const handle = getHandle();
    if (!handle || runningSlotReleased) return;
    handle.releaseRunningSlot();
    runningSlotReleased = true;
  };
  const releaseAll = (): void => {
    releaseStartSlot();
    releaseRunningSlot();
  };

  return { releaseStartSlot, releaseRunningSlot, releaseAll };
}
