import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VISUAL_STYLE_STORAGE_KEY,
  applyVisualStyle,
  mergeVisualStylePreferenceState,
  parseVisualStylePreference,
  persistVisualStylePreference,
  persistVisualStylePreferenceSyncPending,
  readInitialVisualStylePreferenceState,
  readVisualStylePreference,
  readVisualStylePreferenceSyncPending,
  readVisualStyle,
  reconcileVisualStylePreference,
  sanitizeVisualStyle,
  shouldReconcileVisualStylePreference,
} from "../src/visual-style";

describe("visual style", () => {
  it("fails closed to YUI for an unknown persisted value", () => {
    expect(sanitizeVisualStyle("unexpected")).toBe("yui");
    expect(readVisualStyle({ getItem: () => "unexpected" })).toBe("yui");
  });

  it("fails closed when browser storage itself cannot be accessed", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage unavailable"); } });

    try {
      expect(readVisualStyle()).toBe("yui");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("uses Minimal only when the exact persisted value is valid", () => {
    expect(readVisualStyle({ getItem: (key) => key === VISUAL_STYLE_STORAGE_KEY ? "minimal" : null })).toBe("minimal");
  });

  it("parses exact preferences and keeps a newer local preference", () => {
    const local = { style: "minimal" as const, revision: 3, updatedAt: "2026-08-26T00:00:00.000Z" };
    const remote = { style: "yui" as const, revision: 2, updatedAt: "2026-08-26T01:00:00.000Z" };

    expect(parseVisualStylePreference({ style: "minimal", revision: 2, updatedAt: "2026-08-26T00:00:00.000Z" }))
      .toEqual({ style: "minimal", revision: 2, updatedAt: "2026-08-26T00:00:00.000Z" });
    expect(parseVisualStylePreference({ style: "unknown", revision: 2, updatedAt: "2026-08-26T00:00:00.000Z" })).toBeNull();
    expect(reconcileVisualStylePreference(local, remote)).toEqual(local);
  });

  it("keeps the latest local preference metadata across a failed account sync without inventing a server revision", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const local = { style: "minimal" as const, revision: 4, updatedAt: "2026-08-26T02:00:00.000Z" };

    persistVisualStylePreference(local, storage);

    expect(readVisualStylePreference(storage)).toEqual(local);
    expect(reconcileVisualStylePreference(readVisualStylePreference(storage), null)).toEqual(local);
    expect(reconcileVisualStylePreference(readVisualStylePreference(storage), { style: "yui", revision: 3, updatedAt: "2026-08-26T03:00:00.000Z" }))
      .toEqual(local);
    persistVisualStylePreferenceSyncPending(true, storage);
    expect(readVisualStylePreferenceSyncPending(storage)).toBe(true);
    persistVisualStylePreferenceSyncPending(false, storage);
    expect(readVisualStylePreferenceSyncPending(storage)).toBe(false);
    expect(shouldReconcileVisualStylePreference(true)).toBe(false);
    expect(shouldReconcileVisualStylePreference(false)).toBe(true);
  });

  it.each([1, 2, 3])("recovers the visible style as pending when local storage write %i fails", (failedWrite) => {
    const values = new Map<string, string>();
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === failedWrite) throw new Error("storage quota");
        values.set(key, value);
      },
    };

    persistVisualStylePreference({ style: "minimal", revision: 4, updatedAt: "2026-08-26T02:00:00.000Z" }, storage, true);

    expect(readInitialVisualStylePreferenceState(storage, () => "2026-08-26T02:00:01.000Z")).toEqual({
      preference: { style: "minimal", revision: 4, updatedAt: expect.any(String) },
      syncPending: true,
      intentSequence: expect.any(Number),
      intentOrigin: expect.any(String),
    });
  });

  it.each([1, 2, 3])("does not restore an older pending style when local storage write %i fails", (failedWrite) => {
    const values = new Map<string, string>([
      ["zundamon-ai.visual-style.v1", "yui"],
      ["zundamon-ai.visual-style.preference.v1", JSON.stringify({ style: "yui", revision: 4, updatedAt: "2026-08-26T02:00:00.000Z", syncPending: true })],
      ["zundamon-ai.visual-style.sync-pending.v1", "pending"],
    ]);
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === failedWrite) throw new Error("storage quota");
        values.set(key, value);
      },
    };

    persistVisualStylePreference({ style: "minimal", revision: 4, updatedAt: "2026-08-26T01:00:00.000Z" }, storage, true);

    expect(readInitialVisualStylePreferenceState(storage)).toMatchObject({
      preference: { style: "minimal", revision: 4 },
      syncPending: true,
    });
  });

  it("keeps a settled authoritative record when its legacy mirror write fails", () => {
    const values = new Map<string, string>([["zundamon-ai.visual-style.v1", "yui"]]);
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === 3) throw new Error("storage quota");
        values.set(key, value);
      },
    };

    persistVisualStylePreference({ style: "minimal", revision: 5, updatedAt: "2026-08-26T03:00:00.000Z" }, storage, false);

    expect(readInitialVisualStylePreferenceState(storage)).toMatchObject({
      preference: { style: "minimal", revision: 5 },
      syncPending: false,
      intentSequence: 1,
    });
  });

  it("treats a visible legacy style that differs from metadata as the latest pending intent", () => {
    const values = new Map<string, string>([
      ["zundamon-ai.visual-style.v1", "minimal"],
      ["zundamon-ai.visual-style.preference.v1", JSON.stringify({ style: "yui", revision: 4, updatedAt: "2026-08-26T02:00:00.000Z", syncPending: false })],
      ["zundamon-ai.visual-style.sync-pending.v1", "settled"],
    ]);

    expect(readInitialVisualStylePreferenceState({ getItem: (key) => values.get(key) ?? null }, () => "2026-08-26T02:00:01.000Z")).toEqual({
      preference: { style: "minimal", revision: 4, updatedAt: "2026-08-26T02:00:01.000Z" },
      syncPending: true,
    });
  });

  it("keeps a newer pending intent while adopting the server revision from an older settled tab", () => {
    const current = { preference: { style: "yui" as const, revision: 5, updatedAt: "2026-08-26T02:00:02.000Z" }, syncPending: true };
    const incoming = { preference: { style: "minimal" as const, revision: 6, updatedAt: "2026-08-26T02:00:01.000Z" }, syncPending: false };

    expect(mergeVisualStylePreferenceState(current, incoming)).toEqual({
      preference: { style: "yui", revision: 6, updatedAt: "2026-08-26T02:00:02.000Z" },
      syncPending: true,
    });
    expect(mergeVisualStylePreferenceState(current, {
      preference: { style: "minimal", revision: 7, updatedAt: "2026-08-26T02:00:03.000Z" }, syncPending: false,
    })).toEqual({
      preference: { style: "yui", revision: 7, updatedAt: "2026-08-26T02:00:02.000Z" }, syncPending: true,
    });
    expect(mergeVisualStylePreferenceState(current, {
      preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T02:00:03.000Z" }, syncPending: true,
    })).toEqual({
      preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T02:00:03.000Z" }, syncPending: true,
    });
    expect(mergeVisualStylePreferenceState({ ...current, intentSequence: 1, intentOrigin: "tab-a" }, {
      preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T02:00:02.000Z" },
      syncPending: true,
      intentSequence: 2,
      intentOrigin: "tab-b",
    })).toEqual({
      preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T02:00:02.000Z" },
      syncPending: true,
      intentSequence: 2,
      intentOrigin: "tab-b",
    });
    expect(mergeVisualStylePreferenceState(
      { ...current, intentSequence: 1, intentOrigin: "tab-a" },
      {
        preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T01:59:59.000Z" },
        syncPending: true,
        intentSequence: 2,
        intentOrigin: "tab-b",
      },
    )).toEqual({
      preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T01:59:59.000Z" },
      syncPending: true,
      intentSequence: 2,
      intentOrigin: "tab-b",
    });
    expect(mergeVisualStylePreferenceState(
      { ...current, intentSequence: 2, intentOrigin: "tab-a" },
      {
        preference: { style: "minimal", revision: 5, updatedAt: "2026-08-26T02:00:02.000Z" },
        syncPending: true,
        intentSequence: 2,
        intentOrigin: "tab-b",
      },
    )).toMatchObject({ preference: { style: "minimal" }, intentSequence: 2, intentOrigin: "tab-b" });
    const newerSettled = {
      preference: { style: "minimal" as const, revision: 7, updatedAt: "2026-08-26T02:00:04.000Z" },
      syncPending: false,
      intentSequence: 2,
      intentOrigin: "tab-b",
    };
    const olderPending = {
      preference: { style: "yui" as const, revision: 6, updatedAt: "2026-08-26T02:00:05.000Z" },
      syncPending: true,
      intentSequence: 1,
      intentOrigin: "tab-a",
    };
    expect(mergeVisualStylePreferenceState(newerSettled, olderPending)).toEqual(newerSettled);
    expect(mergeVisualStylePreferenceState(olderPending, newerSettled)).toEqual(newerSettled);
    expect(mergeVisualStylePreferenceState(
      { ...newerSettled, preference: { ...newerSettled.preference, style: "yui" }, syncPending: true },
      { ...olderPending, preference: { ...olderPending.preference, style: "minimal", revision: 8 }, syncPending: false },
    )).toEqual({
      preference: { style: "yui", revision: 8, updatedAt: "2026-08-26T02:00:04.000Z" },
      syncPending: true,
      intentSequence: 2,
      intentOrigin: "tab-b",
    });
  });

  it("sets one root style attribute without touching feature state", () => {
    const root = document.documentElement;
    root.removeAttribute("data-yui-style");

    applyVisualStyle("minimal", root);

    expect(root.getAttribute("data-yui-style")).toBe("minimal");
    expect(root.attributes).toHaveLength(1);
  });

  it("defines distinct YUI and Minimal tokens for both OS color schemes", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    expect(styles).toMatch(/:root\[data-yui-style="yui"\]\s*\{[^}]*--yui-canvas:\s*#F6F4FC;/s);
    expect(styles).toMatch(/:root\[data-yui-style="minimal"\]\s*\{[^}]*--yui-canvas:\s*#FEFEFD;/s);
    expect(styles).toContain(':root[data-yui-style="yui"] .yui-speech-bubble');
    expect(styles).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*:root\[data-yui-style="minimal"\]\s*\{[^}]*--yui-canvas:\s*#1D1D1D;/s);
  });

  it("keeps each visual-style choice aligned instead of inheriting the full-width settings input rule", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    expect(styles).toMatch(/\.settings-content \.visual-style-settings label\s*\{[^}]*grid-template-columns:\s*20px minmax\(0,\s*1fr\);[^}]*min-height:\s*44px;/s);
    expect(styles).toMatch(/\.settings-content \.visual-style-settings input\[type="radio"\]\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
  });

  it("keeps the refined shell, focus, navigation, and send affordances in the shared stylesheet", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    expect(styles).not.toMatch(/@media \(min-width:\s*721px\)\s*\{[^}]*\.chat-screen[^}]*border-(?:right|left)/s);
    expect(styles).toMatch(/:root\[data-yui-style="yui"\] body\s*\{[^}]*radial-gradient/s);
    expect(styles).toMatch(/\.integrated-navigation\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.composer-shell:focus-within\s*\{[^}]*border-color:\s*var\(--yui-divider\);[^}]*translateY\(-1px\)/s);
    expect(styles).toMatch(/\.integrated-navigation-button\.is-current::after[^}]*content:\s*none/s);
    expect(styles).toMatch(/\.send-action:disabled\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).toContain("@media (forced-colors: active)");
  });
});
