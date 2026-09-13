import { describe, expect, it } from "vitest";
import { StreamingSentenceBuffer } from "../src/sentence-buffer";
describe("StreamingSentenceBuffer", () => {
  it("emits Japanese sentences in streaming order", () => { const buffer = new StreamingSentenceBuffer(); expect(buffer.push("今日は")).toEqual([]); expect(buffer.push("元気ですか？「私は")).toEqual(["今日は元気ですか？"]); expect(buffer.push("元気です」！次です。")).toEqual(["「私は元気です」！", "次です。"]); expect(buffer.finish()).toEqual([]); });
  it("flushes response remainders and discards whitespace", () => { const buffer = new StreamingSentenceBuffer(); buffer.push("返事の途中"); expect(buffer.finish()).toEqual(["返事の途中"]); expect(buffer.push("  \n ")).toEqual([]); expect(buffer.finish()).toEqual([]); });
  it("uses a comma between 60 and 120 or hard splits at 120", () => { const comma = new StreamingSentenceBuffer(); expect(comma.push("あ".repeat(70) + "、" + "い".repeat(60))).toEqual(["あ".repeat(70) + "、"]); const hard = new StreamingSentenceBuffer(); expect(hard.push("あ".repeat(121))).toEqual(["あ".repeat(120)]); });
  it("counts surrogate pairs by code point", () => { const buffer = new StreamingSentenceBuffer(); expect(buffer.push("😀".repeat(161))).toEqual(["😀".repeat(120)]); expect([...buffer.finish()[0]!]).toHaveLength(41); });
});
