import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGoogleSourceChoiceStore } from "../src/google-source-choice";

describe("owner-scoped Google source choice", () => {
  beforeEach(() => {
    const values = new Map<string,string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string,value: string) => values.set(key,value), removeItem:(key: string) => values.delete(key) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("retains only the selected source metadata for its owner across reloads", () => {
    createGoogleSourceChoiceStore("owner-a").set("calendar", { id: "work@example.test", title: "仕事" });
    expect(createGoogleSourceChoiceStore("owner-a").get("calendar")).toEqual({ id: "work@example.test", title: "仕事" });
    expect(createGoogleSourceChoiceStore("owner-b").get("calendar")).toBeNull();
    expect(createGoogleSourceChoiceStore("owner-a").get("tasks")).toBeNull();
    createGoogleSourceChoiceStore("owner-a").set("calendar", null);
    expect(createGoogleSourceChoiceStore("owner-a").get("calendar")).toBeNull();
  });
  it("rejects corrupted or unbounded storage and keeps ownerless fixtures in memory only", () => {
    localStorage.setItem("zundamon-ai-google-source:owner-a:tasks", JSON.stringify({id: "a", title: "x", events: ["private"]}));
    expect(createGoogleSourceChoiceStore("owner-a").get("tasks")).toBeNull();
    const store = createGoogleSourceChoiceStore();
    store.set("tasks", {id:"list-b", title:"仕事"});
    expect(store.get("tasks")?.id).toBe("list-b");
    expect(createGoogleSourceChoiceStore().get("tasks")).toBeNull();
    expect(()=>store.set("tasks", {id:"x".repeat(1025),title:"bad"})).toThrow();
  });
});
