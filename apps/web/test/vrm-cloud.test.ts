import { describe, expect, it, vi } from "vitest";
import { createVrmCloud } from "../src/vrm/vrm-cloud";
import type { LocalVrm } from "../src/vrm/vrm-file";
function model(): LocalVrm {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: { name: "Test", authors: ["Author"] },
      },
    },
  });
  const encoded = new TextEncoder().encode(
    json.padEnd(Math.ceil(json.length / 4) * 4, " "),
  );
  const data = new ArrayBuffer(20 + encoded.length),
    v = new DataView(data);
  [0x46546c67, 2, data.byteLength, encoded.length, 0x4e4f534a].forEach((n, i) =>
    v.setUint32(i * 4, n, true),
  );
  new Uint8Array(data, 20).set(encoded);
  return {
    data,
    id: "22222222-2222-4222-8222-222222222222",
    fileName: "test.vrm",
    name: "Test",
    author: "Author",
    version: "1",
  };
}
const ownerId = "11111111-1111-4111-8111-111111111111";
const metadata = {
  revision: 1,
  mode: "vrm",
  model_id: "33333333-3333-4333-8333-333333333333",
  file_name: "test.vrm",
};
const options = {
  url: "https://example.supabase.co",
  key: "public",
  ownerId,
  getSession: async () => ({
    userId: ownerId,
    email: "test@example.com",
    accessToken: "test-token",
  }),
};
describe("private VRM cloud storage", () => {
  it("downloads on a fresh device, then reuses validated bytes for an unchanged model", async () => {
    const m = model();
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([metadata]))
      .mockResolvedValueOnce(new Response(m.data))
      .mockResolvedValueOnce(Response.json([metadata]));
    const cloud = createVrmCloud({ ...options, fetchImpl: f });
    const first = await cloud.load();
    expect(first.storage).toBe("server");
    expect(first.model?.id).toBe(metadata.model_id);
    const second = await cloud.load(first.model);
    expect(second.model).toBe(first.model);
    expect(f).toHaveBeenCalledTimes(3);
    expect(new Headers(f.mock.calls[1]![1]!.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(String(f.mock.calls[1]![0])).toContain(
      "/object/authenticated/zundamon-vrm/" + ownerId,
    );
  });
  it("does not send any request if the signed-in account changed", async () => {
    const f = vi.fn<typeof fetch>();
    const cloud = createVrmCloud({
      ...options,
      fetchImpl: f,
      getSession: async () => ({
        ...(await options.getSession()),
        userId: "other",
      }),
    });
    await expect(cloud.load()).rejects.toThrow("ログイン");
    expect(f).not.toHaveBeenCalled();
  });
  it("never publishes a failed upload or deletes the previous model", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([metadata]))
      .mockResolvedValueOnce(new Response("", { status: 413 }));
    const cloud = createVrmCloud({ ...options, fetchImpl: f });
    await cloud.check();
    await expect(cloud.save({ mode: "vrm", model: model() })).rejects.toThrow(
      "アップロード",
    );
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls.every((c) => c[1]?.method !== "DELETE")).toBe(true);
  });
  it("publishes new bytes before removing only the superseded file", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([metadata]))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({
          ...metadata,
          revision: 2,
          model_id: "44444444-4444-4444-8444-444444444444",
        }),
      )
      .mockResolvedValueOnce(Response.json([]));
    const cloud = createVrmCloud({ ...options, fetchImpl: f });
    await cloud.check();
    await cloud.save({ mode: "vrm", model: model() });
    expect(f.mock.calls.map((c) => c[1]?.method)).toEqual([
      undefined,
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string).p_revision).toBe(1);
    expect(JSON.parse(f.mock.calls[3]![1]!.body as string).prefixes).toEqual([
      ownerId + "/" + metadata.model_id + ".vrm",
    ]);
  });
  it("does not delete a potentially committed upload on an ambiguous publish failure", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([metadata]))
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValueOnce(Error("network"));
    const cloud = createVrmCloud({ ...options, fetchImpl: f });
    await cloud.check();
    await expect(cloud.save({ mode: "vrm", model: model() })).rejects.toThrow();
    expect(f.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
  });
  it("reports a concurrent edit and cleans only the losing upload", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([metadata]))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("", { status: 409 }))
      .mockResolvedValueOnce(Response.json([]));
    const cloud = createVrmCloud({ ...options, fetchImpl: f });
    await cloud.check();
    await expect(cloud.save({ mode: "vrm", model: model() })).rejects.toThrow(
      "別の端末",
    );
    expect(f.mock.calls[3]![1]!.body).not.toContain(metadata.model_id);
  });
});
