import { describe, expect, it, vi } from "vitest";
import { createPhotoComposer } from "../src/photo-composer";
import { createPreparedPhoto } from "../src/photo-preparation";

function prepared() {
  const blob = new Blob(["compressed"], { type: "image/jpeg" });
  const revoke = vi.fn();
  return { blob, revoke, value: createPreparedPhoto({ blob, previewUrl: "blob:preview", width: 10, height: 5, revokeObjectURL: revoke }) };
}

describe("prepared photo ownership", () => {
  it("moves the sole compressed Blob into a retryable lease and disposes once on terminal settlement", () => {
    const item = prepared();
    const lease = item.value.transfer();
    lease.markRetryable();
    expect(lease.blob()).toBe(item.blob);
    lease.terminal();
    lease.terminal();
    expect(item.revoke).toHaveBeenCalledOnce();
    expect(() => lease.blob()).toThrow("photo_blob_released");
  });

  it("invalidates every PreparedPhoto accessor after transfer", () => {
    const item = prepared();
    item.value.transfer();
    expect(() => item.value.blob).toThrow("photo_ownership_transferred");
    expect(() => item.value.previewUrl).toThrow("photo_ownership_transferred");
    expect(() => item.value.dispose()).toThrow("photo_ownership_transferred");
    expect(() => item.value.transfer()).toThrow("photo_ownership_transferred");
  });

  it.each(["finish", "cancel", "terminal"] as const)("releases exactly once on %s", (method) => {
    const item = prepared();
    const lease = item.value.transfer();
    lease[method](); lease[method]();
    expect(item.revoke).toHaveBeenCalledOnce();
  });
});

describe("photo composer state", () => {
  it("runs idle through preview, sending, retryable, and terminal", () => {
    const composer = createPhotoComposer();
    expect(composer.state).toBe("idle");
    composer.beginPreparing(); expect(composer.state).toBe("preparing");
    composer.showPreview(prepared().value); expect(composer.state).toBe("preview");
    composer.transfer(); expect(composer.state).toBe("sending");
    composer.markRetryable(); expect(composer.state).toBe("retryable");
    composer.terminal(); expect(composer.state).toBe("terminal");
  });

  it("disposes an untransferred preview on cancel and another selection", () => {
    const first = prepared(); const second = prepared(); const composer = createPhotoComposer();
    composer.beginPreparing(); composer.showPreview(first.value); composer.beginPreparing();
    expect(first.revoke).toHaveBeenCalledOnce();
    composer.showPreview(second.value); composer.cancel();
    expect(second.revoke).toHaveBeenCalledOnce();
    expect(composer.state).toBe("idle");
  });
});
