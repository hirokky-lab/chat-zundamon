import { describe, expect, it, vi } from "vitest";
import { createWorkAssistApi } from "../src/api";

const request = {
  requestId: "work-assist-1",
  conversationId: "conversation-main",
  mode: "organize" as const,
  text: "確認済みの事実と次の作業を整理する",
  confirmationToken: "confirmed-operation-envelope",
};

const success = {
  status: "success" as const,
  result: {
    summary: "確認済みの事実を整理しました",
    tasks: ["次の作業を確認する"],
    draft: null,
    workplacePolicy: "unknown" as const,
  },
};

describe("work assistance API", () => {
  it("posts only the bounded request fields to the fixed same-origin endpoint", async () => {
    const fetch = vi.fn(async () => Response.json(success));
    const signal = new AbortController().signal;

    await expect(createWorkAssistApi(fetch).assist({
      ...request,
      rawPrompt: "API key: sk-proj-never-send-this-private-value",
    } as typeof request, signal)).resolves.toEqual(success);

    expect(fetch).toHaveBeenCalledWith("/api/work-assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  });

  it("omits the optional confirmation token when it is absent", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "confirmation_required" }, { status: 409 }));
    const { confirmationToken: _confirmationToken, ...unconfirmed } = request;

    await expect(createWorkAssistApi(fetch).assist(unconfirmed)).resolves.toEqual({ status: "confirmation_required" });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual(unconfirmed);
  });

  it.each([
    { ...success, rawResponse: "provider detail" },
    { ...success, result: { ...success.result, workplacePolicy: "known" } },
    { ...success, result: { ...success.result, tasks: Array.from({ length: 9 }, (_, index) => `task ${index}`) } },
    { ...success, result: { ...success.result, summary: "API key: sk-proj-abcdefghijklmnopqrstuvwxyz123456" } },
    { status: "success", result: { summary: "整理しました", tasks: [], draft: null } },
  ])("fails closed when the success response exceeds the four-field contract", async (payload) => {
    await expect(createWorkAssistApi(async () => Response.json(payload)).assist(request))
      .resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    { ...success, result: { ...success.result, summary: "パスワードは hunter2" } },
    { ...success, result: { ...success.result, tasks: ["API token is sunshine"] } },
    { ...success, result: { ...success.result, draft: "カード番号は 4111 1111 1111 1111" } },
    { ...success, result: { ...success.result, draft: "QmFzZTY0U2VjcmV0KysvPQ==" } },
  ])("rejects canonical forbidden-secret forms in every result field", async (payload) => {
    await expect(createWorkAssistApi(async () => Response.json(payload)).assist(request))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("accepts a safe non-null draft without broadening the result contract", async () => {
    const withDraft = { ...success, result: { ...success.result, draft: "確認用のメール下書きです" } };
    await expect(createWorkAssistApi(async () => Response.json(withDraft)).assist(request)).resolves.toEqual(withDraft);
  });

  it("accepts only bounded text at the exact summary, task, and draft limits", async () => {
    const bounded = {
      ...success,
      result: {
        ...success.result,
        summary: "要".repeat(1_000),
        tasks: ["作".repeat(240)],
        draft: "文".repeat(4_000),
      },
    };

    await expect(createWorkAssistApi(async () => Response.json(bounded)).assist(request)).resolves.toEqual(bounded);
  });

  it.each([
    { ...success, result: { ...success.result, summary: "要".repeat(1_001) } },
    { ...success, result: { ...success.result, tasks: ["作".repeat(241)] } },
    { ...success, result: { ...success.result, draft: "文".repeat(4_001) } },
    { ...success, result: { ...success.result, summary: "" } },
    { ...success, result: { ...success.result, tasks: [" 前後空白 "] } },
    { ...success, result: { ...success.result, draft: "改行\nを含む" } },
    { ...success, result: { ...success.result, summary: "制御\u0000文字" } },
    { ...success, result: { ...success.result, tasks: [""] } },
    { ...success, result: { ...success.result, draft: "  " } },
  ])("rejects over-limit, empty, padded, or control-character text in every result field", async (payload) => {
    await expect(createWorkAssistApi(async () => Response.json(payload)).assist(request))
      .resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    [409, { status: "confirmation_required" }],
    [400, { status: "sensitive_input_blocked" }],
    [503, { status: "unavailable" }],
  ] as const)("accepts only the fixed failure status for HTTP %s", async (status, outcome) => {
    await expect(createWorkAssistApi(async () => Response.json(outcome, { status })).assist(request))
      .resolves.toEqual(outcome);

    await expect(createWorkAssistApi(async () => Response.json({ ...outcome, detail: "private" }, { status })).assist(request))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("normalizes transport, invalid JSON, and unexpected HTTP failures without exposing their details", async () => {
    await expect(createWorkAssistApi(async () => { throw new TypeError("private upstream URL"); }).assist(request))
      .resolves.toEqual({ status: "unavailable" });
    await expect(createWorkAssistApi(async () => new Response("not-json", { status: 200 })).assist(request))
      .resolves.toEqual({ status: "unavailable" });
    await expect(createWorkAssistApi(async () => new Response("private", { status: 502 })).assist(request))
      .resolves.toEqual({ status: "unavailable" });
  });
});
