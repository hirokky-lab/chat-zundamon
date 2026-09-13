import { createFixtureTriggerAdapter, type ProactiveCandidate } from "@yui/domain";
import { describe, expect, it } from "vitest";
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
  it("keeps reminder delivery metadata isolated without persisting reminder text", async () => {
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

  });
});
