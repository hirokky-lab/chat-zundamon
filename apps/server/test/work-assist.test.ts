import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { ALL_EXTERNAL_TOOLS_OFF } from "../src/external-tools";

const validPayload = {
  requestId: "work-assist-1",
  conversationId: "conversation-main",
  mode: "organize",
  text: "確認済みの事実と次の作業を整理する",
  confirmationToken: "confirmed-operation-envelope",
};

function validGateway() {
  return {
    generate: vi.fn(async () => ({
      value: {
        summary: "確認済みの事実を整理しました",
        tasks: ["次の作業を確認する"],
        draft: null,
        workplacePolicy: "unknown" as const,
      },
      actualUsd: 0,
      quotaUnits: 0,
    })),
  };
}

function buildWorkApp(options: Parameters<typeof buildApp>[0]) {
  return buildApp({
    extractor: { extract: async () => ({ candidates: [] }) },
    ...options,
  });
}

describe("owner-only work assistance", () => {
  it("does not expose the route while the feature is OFF", async () => {
    const gateway = validGateway();
    const app = buildWorkApp({ workAssistGateway: gateway });

    const response = await app.inject({ method: "POST", url: "/api/work-assist", payload: validPayload });

    expect(response.statusCode).toBe(404);
    expect(gateway.generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an explicit operation confirmation before passing work text to the gateway", async () => {
    const gateway = validGateway();
    const app = buildWorkApp({
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, work_assist: true },
      workAssistGateway: gateway,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/work-assist",
      payload: { ...validPayload, confirmationToken: undefined },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: "confirmation_required" });
    expect(gateway.generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks secret-like input before the boundary or gateway and returns no input detail", async () => {
    const gateway = validGateway();
    const app = buildWorkApp({
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, work_assist: true },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: gateway,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/work-assist",
      payload: { ...validPayload, text: "API key: sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: "sensitive_input_blocked" });
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(response.body).not.toContain("sk-proj");
    await app.close();
  });

  it("returns only the strict work result after confirmed fixture execution", async () => {
    const gateway = validGateway();
    const app = buildWorkApp({
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, work_assist: true },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: gateway,
    });

    const response = await app.inject({ method: "POST", url: "/api/work-assist", payload: validPayload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "success",
      result: {
        summary: "確認済みの事実を整理しました",
        tasks: ["次の作業を確認する"],
        draft: null,
        workplacePolicy: "unknown",
      },
    });
    expect(gateway.generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(response.json())).not.toContain("memory");
    await app.close();
  });

  it("fails closed when the gateway returns unknown fields", async () => {
    const generate = vi.fn(async () => ({
      value: {
        summary: "整理しました",
        tasks: [],
        draft: null,
        workplacePolicy: "unknown",
        rawResponse: "provider detail",
      },
      actualUsd: 0,
      quotaUnits: 0,
    }));
    const app = buildWorkApp({
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, work_assist: true },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: { generate },
    });

    const response = await app.inject({ method: "POST", url: "/api/work-assist", payload: validPayload });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("provider detail");
    await app.close();
  });

  it("fails closed without exposing secret-like gateway output", async () => {
    const generate = vi.fn(async () => ({
      value: {
        summary: "API key: sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        tasks: [],
        draft: null,
        workplacePolicy: "unknown",
      },
      actualUsd: 0,
      quotaUnits: 0,
    }));
    const app = buildWorkApp({
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, work_assist: true },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: { generate },
    });

    const response = await app.inject({ method: "POST", url: "/api/work-assist", payload: validPayload });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("sk-proj");
    await app.close();
  });
});
