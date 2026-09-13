import { describe, expect, it, vi } from "vitest";
import { createTtsClient } from "../src/tts-client";
describe("createTtsClient", () => {
  it("uses local endpoints and forwards cancellation signals", async () => { const signal = new AbortController().signal; const fetch = vi.fn(async (url: RequestInfo | URL) => url === "/api/tts/status" ? new Response(JSON.stringify({ available: true })) : new Response(new Blob(["wav"]))); const client = createTtsClient(fetch); await expect(client.status(signal)).resolves.toEqual({ available: true }); await expect(client.synthesize({ requestId: "tts:1:0", text: "こんにちは" }, signal)).resolves.toBeInstanceOf(Blob); expect(fetch.mock.calls[0]?.[0]).toBe("/api/tts/status"); expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal }); expect(fetch.mock.calls[1]?.[0]).toBe("/api/tts/speech"); expect(fetch.mock.calls[1]?.[1]).toMatchObject({ signal, method: "POST" }); });
});
