import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Blob as NodeBlob } from "node:buffer";
import "fake-indexeddb/auto";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WALLPAPER, WALLPAPER_THEMES, wallpaperBackground, wallpaperRecord, useWallpaper, type WallpaperController } from "../src/wallpaper";
import { WallpaperSettings } from "../src/components/WallpaperSettings";

afterEach(() => vi.restoreAllMocks());

describe("wallpaper storage and upload", () => {
  it("ships every current edamame color in both tones with the same wide proportions", async () => {
    for (const theme of WALLPAPER_THEMES) {
      for (const tone of ["day", "night"] as const) {
        const background = wallpaperBackground(theme.id, tone);
        const file = background.match(/url\("\/backgrounds\/([^\"]+)"\)/)?.[1];
        expect(file).toBeDefined();
        const original = await readFile(resolve("public/backgrounds", file!));
        expect(original.readUInt32BE(16)).toBeGreaterThan(0);
        expect(original.subarray(1, 4).toString()).toBe("PNG");
        expect(original.readUInt32BE(16) / original.readUInt32BE(20)).toBeCloseTo(16 / 9, 2);
      }
    }
  });
  it("persists the image and crop together and separates accounts", async () => {
    const value = { ...DEFAULT_WALLPAPER, theme: "custom" as const, x: 23, image: { blob: new NodeBlob(["image"]) as unknown as Blob, width: 1200, height: 800 } };
    await wallpaperRecord("owner-a", value);
    const restored = await wallpaperRecord("owner-a");
    expect(restored?.x).toBe(23);
    expect(restored?.image?.width).toBe(1200);
    expect(await restored?.image?.blob.text()).toBe("image");
    expect(await wallpaperRecord("owner-b")).toBeUndefined();
    await wallpaperRecord("owner-a", DEFAULT_WALLPAPER);
    expect((await wallpaperRecord("owner-a"))?.image).toBeUndefined();
  });

  it("offers only the two built-in wallpapers, without uploads", () => {
    render(<WallpaperSettings controller={{wallpaper:DEFAULT_WALLPAPER,ready:true,saving:false,error:null,save:vi.fn()}}/>);
    expect(screen.queryByText("画像をアップロード")).not.toBeInTheDocument();
    expect(screen.queryByText("こもれびの部屋")).not.toBeInTheDocument();
    expect(screen.queryByText("枝豆（ミルクティー）")).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"枝豆（グリーン）"})).toBeInTheDocument();
    expect(WALLPAPER_THEMES.map(theme => theme.id)).toEqual(["edamame", "edamame-pink"]);
    expect(screen.queryByRole("button",{name:"枝豆（オレンジ）"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"枝豆（ブルー）"})).not.toBeInTheDocument();
  });

  it.each([
    ["leaves", "枝豆（ピンク）", "edamame-pink-night-v2.png"],
    ["edamame-pink", "枝豆（ピンク）", "edamame-pink-night-v2.png"],
    ["edamame-lavender", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["edamame-orange", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["edamame-sky", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["edamame-milktea", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["room", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["custom", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["edamame", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
    ["arches", "枝豆（グリーン）", "edamame-sky-night-v2.png"],
  ])("restores %s into the shared background, including the retired preset", async (theme, label, file) => {
    await wallpaperRecord("restore", { ...DEFAULT_WALLPAPER, theme: theme as typeof DEFAULT_WALLPAPER.theme, tone: "night", mode: undefined });
    function Screen() { const controller = useWallpaper("restore"); return <WallpaperSettings controller={controller} />; }
    render(<Screen />);
    await waitFor(() => expect(screen.getByRole("button", { name: "ダーク" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "リーフ" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--room-background")).toContain(`/backgrounds/${file}`);
      expect(document.documentElement.style.getPropertyValue("--room-size")).toBe("auto 400px");
    });
  });
});

it('follows system changes until the user selects a manual mode', async()=>{
 let dark=false; const listeners=new Set<()=>void>();
 vi.stubGlobal('matchMedia',()=>({get matches(){return dark},addEventListener:(_event:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_event:string,fn:()=>void)=>listeners.delete(fn)}));
 try {
  function Screen(){return <WallpaperSettings controller={useWallpaper('system-mode-test')}/>}
  const view=render(<Screen/>);const user=userEvent.setup();
  await waitFor(()=>expect(screen.getByRole('button',{name:'ダーク'})).toBeEnabled());
  expect(document.documentElement.dataset.colorMode).toBe('light');
  act(()=>{dark=true;listeners.forEach(fn=>fn())});
  await waitFor(()=>expect(document.documentElement.dataset.colorMode).toBe('dark'));
  expect(document.documentElement.style.getPropertyValue('--room-background')).toContain('edamame-sky-night');
  await user.click(screen.getByRole('button',{name:'ライト'}));
  await waitFor(()=>expect(document.documentElement.dataset.colorMode).toBe('light'));
  act(()=>{dark=false;listeners.forEach(fn=>fn());dark=true;listeners.forEach(fn=>fn())});
  expect(document.documentElement.dataset.colorMode).toBe('light');
  view.unmount();expect(listeners.size).toBe(0);
 }finally{vi.unstubAllGlobals()}
});
