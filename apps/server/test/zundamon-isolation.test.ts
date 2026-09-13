import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
describe("independent configuration", () => {
  it("rejects credentials inherited from the source application", () => {
    expect(() => loadConfig({ OPENAI_API_KEY: "old-key", YUI_DB_PATH: "../yui/data/yui.sqlite" })).toThrow();
  });
  it("uses independent paths and ignores old endpoint and permission flags", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "fixture", YUI_MODE: "hosted", YUI_DB_PATH: "../yui/data/yui.sqlite", YUI_CALENDAR_WRITE_ENABLED: "true", SAKURA_AI_API_KEY: "old-key", PORT: "4312" })).toMatchObject({
      mode: "local", port: 4384, dbPath: "./data/zundamon-ai.sqlite", sakuraAiApiKey: undefined,
      googleAssistantWrite: { calendar: false, tasks: false },
    });
  });
});
