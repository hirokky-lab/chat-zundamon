import { Suspense } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createLazyAvatarStage } from "../src/App";
import type { AvatarModelManifest } from "../src/live2d/avatar-contract";

const portrait = { src: "/static-yui.png", alt: "SDずんだもん" };
const manifest: AvatarModelManifest = {
  id: "simple",
  sdkVersion: "5-r.5",
  bridge: { path: "bridge", url: "/live2d/bridge.js", sha256: "a".repeat(64), maxBytes: 100 },
  assets: [{ path: "simple.model3.json", url: "/live2d/simple.model3.json", sha256: "b".repeat(64), maxBytes: 100 }],
  notice: "Live2D公式サンプルの著作権表示候補",
  provisional: true,
};

describe("Live2D loading fallback", () => {
  it("turns a rejected stage chunk into the same static fallback without leaking the error", async () => {
    const RejectedStage = createLazyAvatarStage(async () => { throw new Error("private chunk failure"); });
    render(<Suspense fallback={<span>読込中</span>}><RejectedStage enabled manifest={manifest} fallback={portrait} capability={{ mode: "animate" }} /></Suspense>);

    await waitFor(() => expect(screen.getByText("静止画で表示しています")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "SDずんだもん" })).toHaveAttribute("src", "/static-yui.png");
    expect(screen.queryByText("private chunk failure")).not.toBeInTheDocument();
  });
});
