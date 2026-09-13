import "fake-indexeddb/auto";
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  characterRecord,
  useCharacterPreference,
} from "../src/vrm/vrm-preference";
import type { VrmCloud } from "../src/vrm/vrm-cloud";
const cloud = (): VrmCloud => ({
  check: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue({ mode: "live2d", storage: "server" }),
  save: vi.fn(async (x) => ({ ...x, storage: "server" })),
});
describe("character storage selection", () => {
  it("a new browser adopts cloud settings without selecting a local file", async () => {
    const remote = cloud(),
      scope = crypto.randomUUID();
    const { result } = renderHook(() => useCharacterPreference(scope, remote));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.preference.storage).toBe("server");
    expect(remote.load).toHaveBeenCalledTimes(1);
  });
  it("explicit local storage remains local and does not download server bytes", async () => {
    const scope = crypto.randomUUID();
    await characterRecord(scope, { mode: "live2d", storage: "local" });
    const remote = cloud();
    const { result } = renderHook(() => useCharacterPreference(scope, remote));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(remote.load).not.toHaveBeenCalled();
    expect(remote.check).toHaveBeenCalledTimes(1);
    expect(result.current.preference.storage).toBe("local");
  });
  it("a cloud failure preserves the current selection and local writes still work", async () => {
    const remote = cloud();
    remote.save = vi.fn().mockRejectedValue(Error("接続失敗"));
    const scope = crypto.randomUUID();
    const { result } = renderHook(() => useCharacterPreference(scope, remote));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      expect(
        await result.current.save({ mode: "live2d", storage: "server" }),
      ).toBe(false);
    });
    expect(result.current.error).toBe("接続失敗");
    await act(async () => {
      expect(
        await result.current.save({ mode: "live2d", storage: "local" }),
      ).toBe(true);
    });
    expect(result.current.preference.storage).toBe("local");
  });
});
