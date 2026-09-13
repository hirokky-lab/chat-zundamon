import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { characterRecord } from "../src/vrm/vrm-preference";

describe("character file storage", () => {
  it("keeps selected models on their own account and restores the original file bytes", async () => {
    const model = {
      name: "Test",
      author: "Author",
      version: "1" as const,
      id: "test",
      fileName: "test.vrm",
      data: new Uint8Array([1, 2, 3]).buffer,
    };
    await characterRecord("account-a", { mode: "vrm", model });
    expect(await characterRecord("account-b")).toEqual({ mode: "live2d" });
    const loaded = await characterRecord("account-a");
    expect(loaded.mode).toBe("vrm");
    expect(new Uint8Array(loaded.model!.data)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await characterRecord("account-a", { ...loaded, mode: "live2d" });
    expect((await characterRecord("account-a")).model?.id).toBe("test");
  });
});
