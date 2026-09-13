import { describe, expect, it, vi } from "vitest";
import { createWriteGate, releaseLeaseOnResponseEnd, runClosedRestore, runRestoreMutation, SEMANTIC_MUTATION_BOUNDARIES } from "../src/write-gate";

describe("write gate", () => {
  it("drains accepted semantic work before a restore can use its private permit", async () => {
    const gate = createWriteGate();
    const inFlight = gate.enter("backup_cron");
    expect(inFlight).not.toBeNull();

    gate.closeForRestore();
    expect(gate.enter("photo_cleanup_cron")).toBeNull();
    let drained = false;
    const waiting = gate.waitForDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    inFlight?.release();
    await waiting;
    expect(gate.isOpen()).toBe(false);
    gate.openAfterVerifiedRestore();
    expect(gate.enter("user_mutation")).not.toBeNull();
  });

  it("does not run restore work while the gate is open", async () => {
    const gate = createWriteGate();
    await expect(runClosedRestore(gate, async () => undefined)).rejects.toThrow("restore_gate_not_drained");
  });

  it("permits one closed restore callback only after drain and does not reopen it", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const calls: string[] = [];
    await runClosedRestore(gate, async () => { calls.push("restore"); });
    expect(calls).toEqual(["restore"]);
    expect(gate.isOpen()).toBe(false);
  });

  it("issues a runtime restore session that validates every target mutation", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const mutate = vi.fn(async () => undefined);
    await runClosedRestore(gate, async (session) => {
      await session.runMutation("block_all_photos", (capability) =>
        runRestoreMutation(gate, capability, "block_all_photos", mutate));
    });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("rejects forged, cross-gate, reused, stale, cross-restore, and post-end capabilities", async () => {
    const first = createWriteGate();
    const second = createWriteGate();
    first.closeForRestore();
    second.closeForRestore();
    const mutate = vi.fn(async () => undefined);
    await expect(runRestoreMutation(first, {} as never, "block_all_photos", mutate)).rejects.toThrow("invalid_restore_write_capability");

    let usedCapability: unknown;
    await runClosedRestore(first, async (session) => {
      await session.runMutation("block_all_photos", async (capability) => {
        usedCapability = capability;
        await expect(runRestoreMutation(second, capability, "block_all_photos", mutate)).rejects.toThrow("invalid_restore_write_capability");
        await runRestoreMutation(first, capability, "block_all_photos", mutate);
        await expect(runRestoreMutation(first, capability, "block_all_photos", mutate)).rejects.toThrow("invalid_restore_write_capability");
      });
    });
    await expect(runRestoreMutation(first, usedCapability as never, "block_all_photos", mutate)).rejects.toThrow("invalid_restore_write_capability");

    let staleCapability: unknown;
    await expect(runClosedRestore(first, async (session) => {
      await session.runMutation("replace_non_photo", async (capability) => {
        staleCapability = capability;
        first.openAfterVerifiedRestore();
        await runRestoreMutation(first, capability, "replace_non_photo", mutate);
      });
    })).rejects.toThrow("invalid_restore_write_capability");
    first.closeForRestore();
    await runClosedRestore(first, async (session) => {
      await session.runMutation("verify_lineage", async (capability) => {
        await expect(runRestoreMutation(first, staleCapability as never, "replace_non_photo", mutate)).rejects.toThrow("invalid_restore_write_capability");
        await runRestoreMutation(first, capability, "verify_lineage", mutate);
      });
    });
  });

  it("releases an HTTP mutation lease exactly once for close, error, and finish", () => {
    const listeners = new Map<string, () => void>();
    const response = { once: (event: "finish" | "close" | "error", listener: () => void) => { listeners.set(event, listener); } };
    const release = vi.fn();
    releaseLeaseOnResponseEnd(response, { release });
    listeners.get("close")?.();
    listeners.get("error")?.();
    listeners.get("finish")?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("inventories every semantic mutation sink behind a required write-gate kind", () => {
    expect(SEMANTIC_MUTATION_BOUNDARIES).toEqual({
      chat: "user_mutation", realtime: "user_mutation", transcription: "user_mutation",
      chatState: "user_mutation", profile: "user_mutation", memory: "memory_processing",
      memorySettings: "user_mutation", migrationImport: "user_mutation", usageReserveSettle: "background_job",
      oneTimeReminder: "user_mutation",
      backupCron: "backup_cron", photoCleanupCron: "photo_cleanup_cron", proactiveCron: "proactive_cron",
      startupCleanup: "background_job",
    });
  });
});
