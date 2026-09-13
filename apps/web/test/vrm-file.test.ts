import { describe, expect, it } from "vitest";
import { inspectVrm } from "../src/vrm/vrm-file";

function glb(json: object): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4;
  const data = new ArrayBuffer(20 + length);
  const view = new DataView(data);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, data.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(data, 20).fill(32);
  new Uint8Array(data, 20, text.length).set(text);
  return data;
}
const model = {
  asset: { version: "2.0" },
  extensions: { VRM: { meta: { title: "モデル", author: "作者" } } },
};
describe("local VRM inspection", () => {
  it("reads VRM 0 and 1 names without interpreting model text as markup", () => {
    expect(inspectVrm(glb(model))).toEqual({
      name: "モデル",
      author: "作者",
      version: "0",
    });
    expect(
      inspectVrm(
        glb({
          asset: { version: "2.0" },
          extensions: {
            VRMC_vrm: {
              meta: { name: "<b>Model</b>", authors: ["Author"] },
              specVersion: "1.0",
            },
          },
        }),
      ),
    ).toEqual({ name: "<b>Model</b>", author: "Author", version: "1" });
  });
  it("rejects truncated, non-GLB and non-VRM files", () => {
    for (const data of [
      new ArrayBuffer(0),
      glb(model).slice(0, 24),
      glb({ asset: { version: "2.0" } }),
    ])
      expect(() => inspectVrm(data)).toThrow();
  });
  it("rejects external image and buffer requests before loading a renderer", () => {
    for (const key of ["images", "buffers"])
      for (const uri of [
        "https://example.com/private",
        "file:///secret",
        "blob:other-model",
        "../image.png",
      ]) {
        expect(() => inspectVrm(glb({ ...model, [key]: [{ uri }] }))).toThrow(
          /外部/,
        );
      }
  });
});
