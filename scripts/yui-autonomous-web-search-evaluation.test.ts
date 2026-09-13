import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { runOwnerWebSearchEvaluation } from "./yui-autonomous-web-search-evaluation.js";

const base = (statePath: string) => ({
  statePath,
  contractId: "YUI-AUTONOMOUS-20260822",
  dispatchKey: "web-search-evaluation-20260823-001",
  gateway: { search: vi.fn(async () => ({ usage: { inputTokens: 8_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, searchCalls: 1 } })) },
});

describe("owner web-search evaluation guard", () => {
  it("reserves before one synthetic provider evaluation and persists only aggregate cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "cost.json"));

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "evaluated", settledCents: 2 });
    expect(input.gateway.search).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-luna",
      query: "OpenAI公式情報からWeb search toolの概要を短く確認",
      maxInputTokens: 1_050_000,
      maxOutputTokens: 300,
      maxToolCalls: 2,
    }));
    expect(await readFile(input.statePath, "utf8")).toContain('"settledCents":2');
    expect(await readFile(input.statePath, "utf8")).not.toContain("OpenAI公式情報");
  });

  it("reserves and settles the documented Luna worst-case price before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "cost.json"));
    input.gateway.search.mockResolvedValueOnce({
      usage: { inputTokens: 1_050_000, cachedInputTokens: 0, cacheWriteTokens: 1_050_000, outputTokens: 300, searchCalls: 2 },
    });

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "evaluated", settledCents: 55 });
    expect(await readFile(input.statePath, "utf8")).toContain('"settledCents":55');
  });

  it("does not call the provider when the durable reservation cannot be created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "missing", "cost.json"));

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "not_dispatched" });
    expect(input.gateway.search).not.toHaveBeenCalled();
  });

  it("marks the reservation unknown without exposing a provider failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "cost.json"));
    input.gateway.search.mockRejectedValueOnce(new Error("provider response with secret body"));

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "cost_unverified" });
    const state = await readFile(input.statePath, "utf8");
    expect(state).toContain('"unknownCents":55');
    expect(state).not.toContain("secret body");
  });

  it("marks an over-limit tool result unknown instead of accepting the response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "cost.json"));
    input.gateway.search.mockResolvedValueOnce({ usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searchCalls: 3 } });

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "cost_unverified" });
    expect(await readFile(input.statePath, "utf8")).toContain('"unknownCents":55');
  });

  it("stops the evaluation when an incurred cost cannot be durably marked unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-web-search-evaluation-"));
    const input = base(join(directory, "cost.json"));
    input.gateway.search.mockImplementationOnce(async () => {
      await chmod(directory, 0o755);
      throw new Error("provider body is intentionally unavailable");
    });

    await expect(runOwnerWebSearchEvaluation(input)).resolves.toEqual({ status: "cost_lock_unavailable" });
  });
});
