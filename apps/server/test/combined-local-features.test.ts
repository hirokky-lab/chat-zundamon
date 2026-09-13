import { createFixtureTriggerAdapter, type ProactiveCandidate } from "@yui/domain";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { ALL_EXTERNAL_TOOLS_OFF } from "../src/external-tools";
import { createMemoryProactiveDeliveryRepository, createProactiveMessageService } from "../src/proactive-message";

const ownerId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-29T17:30:00.000Z";
const reminderText = "そろそろ、頼まれていた確認の時間です";
const candidate: ProactiveCandidate = {
  id: "reminder-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: "one_time_reminder",
  sourceRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  templateId: "one_time_reminder_v1",
  purpose: "reminder",
  text: reminderText,
  dedupeKey: "reminder:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  contextRef: "talk:reminder:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-08-29T17:00:00.000Z",
  expiresAt: "2026-08-29T18:00:00.000Z",
  timeZone: "Asia/Tokyo",
  explicitlyRequested: true,
};

describe("combined local server fixture", () => {
  it("keeps reminder delivery metadata isolated while work assistance is independently enabled and disabled", async () => {
    const repository = createMemoryProactiveDeliveryRepository();
    const proactive = createProactiveMessageService({
      enabled: true,
      trigger: createFixtureTriggerAdapter([candidate]),
      repository,
      now: () => now,
    });
    await expect(proactive.open({ ownerId, openedAt: now, notificationsEnabled: true }))
      .resolves.toMatchObject({ status: "candidate", candidate: { text: reminderText } });
    expect(JSON.stringify(await repository.get(ownerId, candidate.id))).not.toContain(reminderText);

    const generate = vi.fn(async () => ({
      value: { summary: "作業を整理しました", tasks: ["確認する"], draft: null, workplacePolicy: "unknown" as const },
      actualUsd: 0,
      quotaUnits: 0,
    }));
    const enabled = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, one_time_reminder: true, work_assist: true },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: { generate },
    });
    const response = await enabled.inject({
      method: "POST",
      url: "/api/work-assist",
      payload: {
        requestId: "combined-work-1",
        conversationId: "conversation-main",
        mode: "organize",
        text: "本人が明示した仕事だけを整理する",
        confirmationToken: "fixture-confirmation",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(generate.mock.calls)).toContain("本人が明示した仕事だけを整理する");
    expect(JSON.stringify(generate.mock.calls)).not.toContain(reminderText);
    await enabled.close();

    const disabled = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, one_time_reminder: true, work_assist: false },
      externalToolConfirmationVerifier: { verify: async () => true },
      workAssistGateway: { generate },
    });
    const disabledResponse = await disabled.inject({
      method: "POST",
      url: "/api/work-assist",
      payload: { requestId: "combined-work-off", conversationId: "conversation-main", mode: "organize", text: "実行しない" },
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(generate).toHaveBeenCalledOnce();
    await disabled.close();
  });
});
