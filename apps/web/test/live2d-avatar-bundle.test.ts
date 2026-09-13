import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Live2D bundle boundary", () => {
  it("loads the stage dynamically instead of importing it into the initial App module", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    expect(source).not.toContain('import { AvatarStage } from "./live2d/AvatarStage"');
    expect(source).toContain('import("./live2d/AvatarStage")');
  });
});
