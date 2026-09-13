import type { PhotoSendLease, PreparedPhoto } from "./photo-preparation";

export type PhotoComposerState = "idle" | "preparing" | "preview" | "sending" | "retryable" | "terminal";

export type PhotoComposer = {
  readonly state: PhotoComposerState;
  beginPreparing(): void;
  showPreview(photo: PreparedPhoto): void;
  transfer(): PhotoSendLease;
  markRetryable(): void;
  finish(): void;
  cancel(): void;
  terminal(): void;
};

export function createPhotoComposer(): PhotoComposer {
  let state: PhotoComposerState = "idle";
  let prepared: PreparedPhoto | null = null;
  let lease: PhotoSendLease | null = null;

  const releaseCurrent = () => {
    if (prepared) prepared.dispose();
    if (lease) lease.cancel();
    prepared = null;
    lease = null;
  };
  const assertState = (...allowed: PhotoComposerState[]) => {
    if (!allowed.includes(state)) throw new Error("invalid_photo_composer_state");
  };

  return {
    get state() { return state; },
    beginPreparing() {
      releaseCurrent();
      state = "preparing";
    },
    showPreview(photo) {
      assertState("preparing");
      prepared = photo;
      state = "preview";
    },
    transfer() {
      assertState("preview");
      lease = (prepared as PreparedPhoto).transfer();
      prepared = null;
      state = "sending";
      return lease;
    },
    markRetryable() {
      assertState("sending", "retryable");
      (lease as PhotoSendLease).markRetryable();
      state = "retryable";
    },
    finish() {
      assertState("sending", "retryable");
      (lease as PhotoSendLease).finish();
      lease = null;
      state = "idle";
    },
    cancel() {
      releaseCurrent();
      state = "idle";
    },
    terminal() {
      if (state === "terminal") return;
      assertState("sending", "retryable");
      (lease as PhotoSendLease).terminal();
      lease = null;
      state = "terminal";
    },
  };
}
