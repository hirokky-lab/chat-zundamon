import { useEffect, useState } from "react";

export type WallpaperTheme = "room" | "edamame" | "edamame-pink" | "edamame-lavender" | "edamame-orange" | "edamame-sky" | "edamame-milktea" | "custom";
export type WallpaperTone = "day" | "night";
export type DisplayMode = "system" | "light" | "dark";
export type WallpaperImage = { blob: Blob; width: number; height: number };
export type Wallpaper = { theme: WallpaperTheme; tone: WallpaperTone; mode?: DisplayMode; image?: WallpaperImage; x: number; y: number };
export const DEFAULT_WALLPAPER: Wallpaper = { theme: "edamame", tone: "day", mode: "system", x: 50, y: 50 };
export const WALLPAPER_THEMES = [
  { id: "edamame", label: "枝豆（グリーン）" },
  { id: "edamame-pink", label: "枝豆（ピンク）" },
] as const;

/** One atomic record per account on this browser; images never enter chat storage. */
export async function wallpaperRecord(scope: string, value?: Wallpaper): Promise<Wallpaper | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("zundamon-ai-wallpapers-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("preferences");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("preferences", value ? "readwrite" : "readonly");
      const request = value ? tx.objectStore("preferences").put(value, scope) : tx.objectStore("preferences").get(scope);
      tx.oncomplete = () => {
        const stored = value ?? request.result;
        // Retired presets retain the user's tone, crop and uploaded image.
        const theme = normalizeWallpaperTheme(stored?.theme);
        resolve(stored ? { ...stored, theme, mode: stored.mode ?? (stored.tone === "night" ? "dark" : "light") } : undefined);
      };
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

const PATTERN_PALETTES = {
  edamame: { day: "edamame-sky-day-v2", night: "edamame-sky-night-v2", dayRgb: "255 251 240", nightRgb: "46 58 94" },
  "edamame-pink": { day: "edamame-pink-day-v2", night: "edamame-pink-night-v2", dayRgb: "255 251 240", nightRgb: "46 58 94" },
} as const;

export function normalizeWallpaperTheme(theme: unknown): keyof typeof PATTERN_PALETTES {
  if (theme === "leaves") return "edamame-pink";
  return typeof theme === "string" && Object.hasOwn(PATTERN_PALETTES, theme) ? theme as keyof typeof PATTERN_PALETTES : "edamame";
}
export function wallpaperBackground(theme: WallpaperTheme, tone: WallpaperTone): string {
  const id = normalizeWallpaperTheme(theme), palette = PATTERN_PALETTES[id];
  const tint = `rgb(${tone === "night" ? palette.nightRgb : palette.dayRgb} / ${tone === "night" ? 20 : 30}%)`;
  return `linear-gradient(${tint}, ${tint}), url("/backgrounds/${palette[tone]}.png")`;
}
export function wallpaperAppearance(theme: WallpaperTheme, tone: WallpaperTone) {
  const palette = PATTERN_PALETTES[normalizeWallpaperTheme(theme)];
  return {background: wallpaperBackground(theme, tone), position: "center", size: "auto 400px", repeat: "repeat", color: "#" + (tone === "night" ? palette.nightRgb : palette.dayRgb).split(" ").map(value => Number(value).toString(16).padStart(2, "0")).join("")};
}

export function useWallpaper(scope: string) {
  const [wallpaper, setWallpaper] = useState<Wallpaper>(DEFAULT_WALLPAPER);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const tone: WallpaperTone = wallpaper.mode === "system" ? (systemDark ? "night" : "day") : wallpaper.mode === "dark" ? "night" : wallpaper.mode === "light" ? "day" : wallpaper.tone;
  useEffect(() => {
    let active = true; setReady(false);
    void wallpaperRecord(scope).then(value => { if (active) setWallpaper(value ?? DEFAULT_WALLPAPER); }, () => {
      if (active) setError("壁紙の保存領域を開けませんでした。ブラウザの保存設定を確認してください。");
    }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [scope]);
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement, style = root.style;
    const appearance = wallpaperAppearance(wallpaper.theme, tone);
    root.dataset.colorMode = tone === "night" ? "dark" : "light";
    style.setProperty("--room-background", appearance.background);
    style.setProperty("--room-position", appearance.position);
    style.setProperty("--room-size", appearance.size);
    style.setProperty("--room-repeat", appearance.repeat);
    style.setProperty("--wallpaper-color", appearance.color);
    style.backgroundColor = appearance.color;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance.color);
    try { localStorage.setItem("zundamon-ai.wallpaper-bootstrap.v1", JSON.stringify({ ...appearance, mode: wallpaper.mode ?? (tone === "night" ? "dark" : "light"), day: wallpaperAppearance(wallpaper.theme,"day"), night: wallpaperAppearance(wallpaper.theme,"night") })); } catch {}
  }, [wallpaper, tone, ready]);
  async function save(next: Wallpaper): Promise<boolean> {
    setSaving(true); setError(null);
    try { await wallpaperRecord(scope, next); setWallpaper(next); return true; }
    catch { setError("保存できませんでした。ブラウザの空き容量や保存設定を確認してください。"); return false; }
    finally { setSaving(false); }
  }
  return { wallpaper: { ...wallpaper, tone }, ready, saving, error, save };
}
export type WallpaperController = ReturnType<typeof useWallpaper>;
