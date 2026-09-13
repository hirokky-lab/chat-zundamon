import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAutonomousFoundation } from "./yui-autonomous-foundation.js";

describe("YUI autonomous foundation runner", () => {
  it("writes owner-only state atomically and emits one safe auto-continue envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yui-autonomy-"));
    const statePath = join(dir, "state.json");
    let output = "";
    await expect(runAutonomousFoundation({ input: { requestId: "YUI-AUTONOMOUS-20260822", taskId: "talk-safe-failures", taskFingerprint: "a".repeat(64), canonicalSha: "b".repeat(40) }, statePath, stdout: (line) => { output += line; } })).resolves.toBe(0);
    expect(JSON.parse(output)).toMatchObject({ outcome: "auto_continue", taskId: "talk-safe-failures" });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(JSON.parse(output));
  });

  it("fails closed without writing state for an invalid input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yui-autonomy-"));
    let output = "";
    await expect(runAutonomousFoundation({ input: { requestId: "sk-secret", taskId: "bad", taskFingerprint: "bad", canonicalSha: "bad" }, statePath: join(dir, "state.json"), stdout: (line) => { output += line; } })).resolves.toBe(1);
    expect(output).toBe('{"code":"autonomous_input_rejected"}\n');
  });
});
