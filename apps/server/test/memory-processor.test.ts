import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { MemoryAction, MemoryCandidateProposal } from "../../../packages/domain/src/memory.js";
import type { CostGuard } from "../src/cost-guard.js";
import { createMemoryRepository } from "../src/db.js";
import type { MemoryExtractor } from "../src/memory-extractor.js";
import {
  MemoryProcessor,
  type AutomaticMemoryTelemetryEvent,
} from "../src/memory-processor.js";
import { LOCAL_USER } from "../src/request-user.js";

const occurredAt = "2026-08-11T00:00:00.000Z";
const input = {
  sourceMessageId: "message-1",
  sourceOccurredAt: occurredAt,
  turns: [
    { role: "user" as const, text: "朝は紅茶を飲むのが好き", provenance: "authoritative_source" as const },
    { role: "assistant" as const, text: "いい朝の習慣だね", provenance: "context" as const },
  ],
};
const voiceInput = {
  sourceMessageId: `voice:${"a".repeat(64)}`,
  sourceOccurredAt: occurredAt,
  sourceOrigin: "voice" as const,
  explicitMemoryTargetTurnIndexes: [],
  turns: [
    { role: "user" as const, text: "水曜日は仕事帰りに駅前の図書館へ寄って新刊を確認している", provenance: "authoritative_source" as const },
    { role: "assistant" as const, text: "いい習慣だね", provenance: "context" as const },
  ],
};

function proposal(content: string): MemoryCandidateProposal {
  return {
    kind: "preference",
    scope: "daily",
    content,
    importance: 3,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    retention: null,
  };
}

function add(content: string): MemoryAction {
  return { type: "add", candidate: proposal(content) };
}

function extractor(actions: unknown[], usage = {
  memoryInputTokens: 100,
  memoryCachedInputTokens: 10,
  memoryCacheWriteTokens: 5,
  memoryOutputTokens: 20,
}): MemoryExtractor {
  return {
    extract: vi.fn(async () => ({ candidates: [], actions, usage })),
  };
}

function createHarness(options: {
  actions?: unknown[];
  extractor?: MemoryExtractor;
  enabled?: boolean | (() => boolean);
  voiceEnabled?: boolean | (() => boolean);
  now?: () => Date;
  usageLog?: { append(user: typeof LOCAL_USER, value: unknown): Promise<void> };
  costGuard?: CostGuard;
  policyVersion?: "natural-v1";
} = {}) {
  const repository = createMemoryRepository(":memory:");
  const events: AutomaticMemoryTelemetryEvent[] = [];
  const usage: unknown[] = [];
  const reservations: Array<{ requestId: string; settled: number[]; held: number }> = [];
  const source = options.extractor ?? extractor(options.actions ?? [add("朝は紅茶を飲むのが好き")]);
  const usageLog = options.usageLog ?? { append: async (_user: typeof LOCAL_USER, value: unknown) => void usage.push(value) };
  const costGuard = options.costGuard ?? {
    reserve: async ({ requestId }: { requestId: string }) => {
      const reservation = { requestId, settled: [] as number[], held: 0 };
      reservations.push(reservation);
      return {
        requestId,
        settle: async (value: number) => void reservation.settled.push(value),
        hold: async () => { reservation.held += 1; },
      };
    },
  } satisfies CostGuard;
  const processor = new MemoryProcessor({
    extractor: source,
    repository,
    automaticMemoryEnabled: () => typeof options.enabled === "function" ? options.enabled() : options.enabled ?? true,
    voiceMemoryEnabled: () => typeof options.voiceEnabled === "function" ? options.voiceEnabled() : options.voiceEnabled ?? true,
    policyVersion: options.policyVersion,
    usageLog,
    costGuard,
    maximumUsd: 0.1,
    telemetry: { record: (event) => void events.push(event) },
    now: options.now ?? (() => new Date(occurredAt)),
  });
  return { processor, repository, extractor: source, events, usage, reservations, usageLog, costGuard };
}

describe("MemoryProcessor", () => {
  it("stops before extraction when the persisted setting turns off during preparation", async () => {
    let enabled = true;
    const harness = createHarness({ enabled: () => enabled });
    const originalList = harness.repository.list.bind(harness.repository);
    const originalListForRecall = harness.repository.listForRecall.bind(harness.repository);
    vi.spyOn(harness.repository, "listForRecall").mockImplementation(async (...args) => {
      const records = await originalListForRecall(...args);
      enabled = false;
      return records;
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed", appliedCount: 0 });
    expect(harness.extractor.extract).not.toHaveBeenCalled();
    expect(await originalList(LOCAL_USER)).toEqual([]);
  });

  it("does not apply extracted actions when the persisted setting turns off in flight", async () => {
    let enabled = true;
    const source: MemoryExtractor = { extract: vi.fn(async () => {
      enabled = false;
      return { candidates: [], actions: [add("処理中に停止した記憶")] };
    }) };
    const harness = createHarness({ extractor: source, enabled: () => enabled });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed", appliedCount: 0 });
    expect(await harness.repository.list(LOCAL_USER)).toEqual([]);
  });

  it("applies at most three valid automatic actions", async () => {
    const harness = createHarness({
      actions: [add("朝は紅茶が好き"), add("夜は読書をする"), add("休日は散歩をする"), add("昼は珈琲を飲む")],
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toEqual({
      sourceMessageId: input.sourceMessageId,
      state: "completed",
      appliedCount: 3,
    });
    expect(await harness.repository.list(LOCAL_USER)).toHaveLength(3);
  });

  it("policy mode writes only one grounded fact and skips external or sensitive turns before extraction", async () => {
    const harness = createHarness({
      policyVersion: "natural-v1",
      actions: [add("朝は紅茶を飲むのが好き")],
    });
    const safeInput = {
      ...input,
      sourceMessageId: "policy-safe",
      sourceContext: { kind: "internal" as const },
      turns: [{ role: "user" as const, text: "私は朝は紅茶を飲むのが好き", provenance: "authoritative_source" as const }],
    };

    await expect(harness.processor.process(LOCAL_USER, safeInput)).resolves.toMatchObject({ state: "completed", appliedCount: 1 });
    await expect(harness.processor.process(LOCAL_USER, {
      ...safeInput,
      sourceMessageId: "policy-external",
      sourceContext: { kind: "external" as const, source: "web_search" as const },
    })).resolves.toMatchObject({ state: "completed", appliedCount: 0 });
    await expect(harness.processor.process(LOCAL_USER, {
      ...safeInput,
      sourceMessageId: "policy-calendar-external",
      sourceContext: { kind: "external" as const, source: "calendar_tasks" as const },
      turns: [{
        role: "user" as const,
        text: "私は朝は紅茶を飲むのが好き event-id-7 attendee@example.com https://source.example",
        provenance: "authoritative_source" as const,
      }],
    })).resolves.toMatchObject({ state: "completed", appliedCount: 0 });
    await expect(harness.processor.process(LOCAL_USER, {
      ...safeInput,
      sourceMessageId: "policy-calendar-followup",
      sourceContext: { kind: "external_followup" as const, sources: ["calendar_tasks" as const] },
      turns: [{ role: "user" as const, text: "それを覚えておいて", provenance: "authoritative_source" as const }],
    })).resolves.toMatchObject({ state: "completed", appliedCount: 0 });
    await expect(harness.processor.process(LOCAL_USER, {
      ...safeInput,
      sourceMessageId: "policy-sensitive",
      turns: [{ role: "user" as const, text: "私は偏頭痛の治療で通院している", provenance: "authoritative_source" as const }],
    })).resolves.toMatchObject({ state: "completed", appliedCount: 0 });
    expect(harness.extractor.extract).toHaveBeenCalledOnce();
  });

  it("policy mode keeps a grounded voice target only when the owner explicitly selected it", async () => {
    const harness = createHarness({
      policyVersion: "natural-v1",
      actions: [add(voiceInput.turns[0].text)],
    });
    const explicitVoice = { ...voiceInput, explicitMemoryTargetTurnIndexes: [0] };

    await expect(harness.processor.process(LOCAL_USER, explicitVoice)).resolves.toMatchObject({ state: "completed", appliedCount: 1 });
    await expect(harness.repository.list(LOCAL_USER)).resolves.toEqual([
      expect.objectContaining({ content: voiceInput.turns[0].text }),
    ]);
  });

  it("policy mode preserves the original chat message as memory provenance", async () => {
    const harness = createHarness({
      policyVersion: "natural-v1",
      actions: [add("朝は紅茶を飲むのが好き")],
    });
    const safeInput = {
      ...input,
      sourceContext: { kind: "internal" as const },
      turns: [{ role: "user" as const, text: "私は朝は紅茶を飲むのが好き", provenance: "authoritative_source" as const }],
    };

    await expect(harness.processor.process(LOCAL_USER, safeInput)).resolves.toMatchObject({ state: "completed", appliedCount: 1 });
    await expect(harness.repository.list(LOCAL_USER)).resolves.toEqual([
      expect.objectContaining({ sourceMessageId: input.sourceMessageId }),
    ]);
  });

  it("returns the completed receipt without extracting or charging again", async () => {
    const harness = createHarness();

    const first = await harness.processor.process(LOCAL_USER, input);
    const duplicate = await harness.processor.process(LOCAL_USER, input);

    expect(duplicate).toEqual(first);
    expect(harness.extractor.extract).toHaveBeenCalledOnce();
    expect(harness.reservations).toHaveLength(1);
    expect(await harness.repository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("uses a receipt domain separate from explicit memory actions", async () => {
    const harness = createHarness();
    const explicitApply = vi.spyOn(harness.repository, "applyPreparedAction");
    const automaticApply = vi.spyOn(harness.repository, "applyPreparedAutomaticAction");

    await harness.processor.process(LOCAL_USER, input);

    expect(explicitApply).not.toHaveBeenCalled();
    expect(automaticApply).toHaveBeenCalledWith(LOCAL_USER, input.sourceMessageId, 0, expect.objectContaining({ type: "add" }));
  });

  it("lets only one of two concurrent deliveries extract and mutate", async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let continueExtraction: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { continueExtraction = resolve; });
    const source: MemoryExtractor = {
      extract: vi.fn(async () => {
        release?.();
        await blocked;
        return { candidates: [], actions: [add("朝は紅茶を飲むのが好き")] };
      }),
    };
    const harness = createHarness({ extractor: source });

    const first = harness.processor.process(LOCAL_USER, input);
    await started;
    const second = await harness.processor.process(LOCAL_USER, input);
    continueExtraction?.();

    expect(second).toEqual({ sourceMessageId: "message-1", state: "pending", appliedCount: 0 });
    await expect(first).resolves.toEqual({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    expect(source.extract).toHaveBeenCalledOnce();
    expect(harness.reservations).toHaveLength(1);
    expect(await harness.repository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("marks extraction failure recoverable without exposing transcript text", async () => {
    const secret = "APIキーは sk-proj-this-must-never-appear-in-logs";
    const source: MemoryExtractor = { extract: vi.fn(async () => { throw new Error(secret); }) };
    const harness = createHarness({ extractor: source });

    await expect(harness.processor.process(LOCAL_USER, { ...input, turns: [{ role: "user", text: secret, provenance: "authoritative_source" }] })).resolves.toEqual({
      sourceMessageId: "message-1",
      state: "failed",
      appliedCount: 0,
    });
    expect(JSON.stringify(harness.events)).not.toContain(secret);
    expect(JSON.stringify(harness.usage)).not.toContain(secret);
    expect(harness.events.at(-1)).toMatchObject({ featureArea: "automatic_memory", outcome: "failure" });
  });

  it("skips malformed and tombstoned actions while applying valid partial output", async () => {
    const harness = createHarness({ actions: [] });
    const forgotten = await harness.repository.create(LOCAL_USER, {
      kind: "preference",
      scope: "daily",
      content: "朝は珈琲が好き",
      origin: "manual",
      sensitivity: "normal",
      importance: 3,
      sourceMessageId: null,
      sourceOccurredAt: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      pinned: true,
      supersedesId: null,
    });
    await harness.repository.forget(LOCAL_USER, forgotten.id, true);
    const hidden = await harness.repository.create(LOCAL_USER, {
      kind: "shared",
      scope: "shared",
      content: "京都に住んでいた",
      origin: "manual",
      sensitivity: "normal",
      importance: 2,
      sourceMessageId: null,
      sourceOccurredAt: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      pinned: true,
      supersedesId: null,
    });
    (harness.extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [],
      actions: [
        { nope: true },
        add("朝は珈琲が好き"),
        add("夜は読書をする"),
        { type: "forget", targetMemoryId: hidden.id, blockRelearning: true },
        add("APIキーは sk-proj-abcdefghijklmnopqrstuvwxyz012345"),
      ],
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toEqual({
      sourceMessageId: "message-1",
      state: "completed",
      appliedCount: 1,
    });
    expect((await harness.repository.list(LOCAL_USER)).map((memory) => memory.content).sort()).toEqual(["京都に住んでいた", "夜は読書をする"].sort());
  });

  it("filters secrets and unpresented targets within the automatic batch", async () => {
    const harness = createHarness({ actions: [] });
    const hidden = await harness.repository.create(LOCAL_USER, {
      kind: "shared",
      scope: "shared",
      content: "京都に住んでいた",
      origin: "manual",
      sensitivity: "normal",
      importance: 2,
      sourceMessageId: null,
      sourceOccurredAt: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      pinned: true,
      supersedesId: null,
    });
    (harness.extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [],
      actions: [
        add("APIキーは sk-proj-abcdefghijklmnopqrstuvwxyz012345"),
        { type: "forget", targetMemoryId: hidden.id, blockRelearning: true },
        add("夜は読書をする"),
      ],
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({
      state: "completed",
      appliedCount: 1,
    });
    expect((await harness.repository.list(LOCAL_USER)).map((memory) => memory.content).sort()).toEqual(["京都に住んでいた", "夜は読書をする"].sort());
  });

  it("never persists policy-rejected content in a failed durable action plan", async () => {
    const secret = "APIキーは sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const harness = createHarness({ actions: [] });
    const hidden = await harness.repository.create(LOCAL_USER, {
      kind: "shared",
      scope: "shared",
      content: "京都に住んでいた",
      origin: "manual",
      sensitivity: "normal",
      importance: 2,
      sourceMessageId: null,
      sourceOccurredAt: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      pinned: true,
      supersedesId: null,
    });
    (harness.extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [],
      actions: [
        add(secret),
        { type: "forget", targetMemoryId: hidden.id, blockRelearning: true },
        add("夜は読書をする"),
      ],
      usage: { memoryInputTokens: 10, memoryCachedInputTokens: 0, memoryCacheWriteTokens: 0, memoryOutputTokens: 2 },
    });
    vi.spyOn(harness.repository, "applyPreparedAutomaticAction").mockRejectedValueOnce(new Error("database unavailable"));

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed" });

    const receipt = await harness.repository.getAutomaticProcessing(LOCAL_USER, input.sourceMessageId);
    const outbox = await harness.repository.getAutomaticOutbox(LOCAL_USER, input.sourceMessageId);
    expect(receipt).toEqual(expect.objectContaining({ outboxRef: expect.any(String) }));
    expect(receipt).not.toHaveProperty("actionPlan");
    expect(outbox?.actions).toEqual([add("夜は読書をする")]);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain(hidden.id);
  });

  it("does not promote model-supplied time fields into automatic memory authority", async () => {
    const candidate = proposal("友達と昼食を食べた");
    candidate.kind = "event";
    candidate.retention = "light";
    candidate.sourceOccurredAt = "2036-08-11T00:00:00.000Z";
    candidate.validFrom = "2036-08-11T00:00:00.000Z";
    candidate.validUntil = "2036-08-12T00:00:00.000Z";
    const harness = createHarness({ actions: [{ type: "add", candidate }] });

    await harness.processor.process(LOCAL_USER, input);

    expect(await harness.repository.list(LOCAL_USER)).toEqual([
      expect.objectContaining({
        sourceOccurredAt: occurredAt,
        validFrom: null,
        validUntil: null,
        expiresAt: "2026-08-14T00:00:00.000Z",
      }),
    ]);
  });

  it("does no receipt, extraction, usage, or cost work while automatic memory is disabled", async () => {
    const harness = createHarness({ enabled: false });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toEqual({
      sourceMessageId: "message-1",
      state: "failed",
      appliedCount: 0,
    });
    expect(harness.extractor.extract).not.toHaveBeenCalled();
    expect(harness.reservations).toEqual([]);
    expect(harness.usage).toEqual([]);
    expect(await harness.repository.getAutomaticProcessing(LOCAL_USER, "message-1")).toBeNull();
  });

  it("keeps a claimed plan retryable when the atomic repository gate observes OFF", async () => {
    const harness = createHarness();
    vi.spyOn(harness.repository, "applyPreparedAutomaticAction").mockResolvedValueOnce("disabled" as never);

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toEqual({
      sourceMessageId: "message-1",
      state: "failed",
      appliedCount: 0,
    });
    expect(await harness.repository.getAutomaticProcessing(LOCAL_USER, input.sourceMessageId)).toMatchObject({ state: "failed" });
    expect(await harness.repository.getAutomaticOutbox(LOCAL_USER, input.sourceMessageId)).not.toBeNull();
    expect(await harness.repository.list(LOCAL_USER)).toEqual([]);
  });

  it.each(["abort", "off", "settlement", "apply"] as const)("clears a temporary voice plan after %s failure", async (failureAt) => {
    let voiceEnabled = true;
    const controller = new AbortController();
    const harness = createHarness({
      actions: [add("水曜は仕事帰りに図書館へ寄る")],
      voiceEnabled: () => voiceEnabled,
      usageLog: failureAt === "settlement"
        ? { append: async () => { throw new Error("settlement unavailable"); } }
        : undefined,
    });
    const save = harness.repository.saveAutomaticOutbox.bind(harness.repository);
    if (failureAt === "abort" || failureAt === "off") {
      vi.spyOn(harness.repository, "saveAutomaticOutbox").mockImplementation(async (...args) => {
        const stored = await save(...args);
        if (failureAt === "abort") controller.abort();
        else voiceEnabled = false;
        return stored;
      });
    }
    if (failureAt === "apply") {
      vi.spyOn(harness.repository, "applyPreparedAutomaticAction").mockRejectedValueOnce(new Error("apply unavailable"));
    }

    await expect(harness.processor.process(LOCAL_USER, voiceInput, controller.signal)).resolves.toMatchObject({ state: "failed" });

    expect(await harness.repository.getAutomaticProcessing(LOCAL_USER, voiceInput.sourceMessageId)).toMatchObject({ state: "failed", outboxRef: null });
    expect(await harness.repository.getAutomaticOutbox(LOCAL_USER, voiceInput.sourceMessageId)).toBeNull();
    expect(await harness.repository.list(LOCAL_USER)).toEqual([]);
  });

  it("pins only the voice candidate grounded in the explicit target turn", async () => {
    const mixedVoiceInput = {
      ...voiceInput,
      sourceMessageId: `voice:${"b".repeat(64)}`,
      explicitMemoryTargetTurnIndexes: [0],
      turns: [
        voiceInput.turns[0],
        { role: "user" as const, text: "日曜日は夕方に近所の映画館で新作映画を一本見る", provenance: "authoritative_source" as const },
      ],
    };
    const harness = createHarness({ actions: [
      add("水曜は仕事帰りに図書館へ寄る"),
      add("日曜夕方は映画館で新作を見る"),
    ] });

    await harness.processor.process(LOCAL_USER, mixedVoiceInput);
    expect(await harness.repository.list(LOCAL_USER)).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "水曜は仕事帰りに図書館へ寄る", pinned: true }),
      expect.objectContaining({ content: "日曜夕方は映画館で新作を見る", pinned: false }),
    ]));
  });

  it("settles extracted usage once and records only classified metrics with latency", async () => {
    const times = [new Date("2026-08-11T00:00:00.000Z"), new Date("2026-08-11T00:00:00.125Z")];
    const harness = createHarness({ now: () => times.shift() ?? new Date("2026-08-11T00:00:00.125Z") });

    await harness.processor.process(LOCAL_USER, input);

    expect(harness.usage).toEqual([expect.objectContaining({ sessionId: expect.stringMatching(/^auto-memory:[a-f0-9]{64}:1$/u) })]);
    expect(JSON.stringify(harness.usage)).not.toContain(input.sourceMessageId);
    expect(JSON.stringify(harness.usage)).not.toContain(input.turns[0].text);
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]?.settled).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      featureArea: "automatic_memory",
      outcome: "success",
      latencyMs: 125,
      charged: true,
      idempotencyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(harness.events)).not.toContain(input.sourceMessageId);
    expect(JSON.stringify(harness.events)).not.toContain(input.turns[0].text);
  });

  it.each([
    ["AbortError", "cancel"],
    ["TimeoutError", "timeout"],
  ] as const)("classifies %s without text", async (name, outcome) => {
    const source: MemoryExtractor = {
      extract: vi.fn(async () => {
        const error = new Error(input.turns[0].text);
        error.name = name;
        throw error;
      }),
    };
    const harness = createHarness({ extractor: source });

    await harness.processor.process(LOCAL_USER, input);

    expect(harness.events.at(-1)).toMatchObject({ outcome });
    expect(JSON.stringify(harness.events)).not.toContain(input.turns[0].text);
  });

  it.each([
    [new OpenAI.APIUserAbortError(), "cancel"],
    [new OpenAI.APIConnectionTimeoutError(), "timeout"],
  ] as const)("classifies the production SDK error as %s", async (error, outcome) => {
    const source: MemoryExtractor = { extract: vi.fn(async () => { throw error; }) };
    const harness = createHarness({ extractor: source });

    await harness.processor.process(LOCAL_USER, input);

    expect(harness.events.at(-1)).toMatchObject({ outcome });
  });

  it("retries ledger settlement from the durable outbox without re-extracting", async () => {
    let offline = true;
    const appended: unknown[] = [];
    const harness = createHarness({ usageLog: { append: async (_user, value) => {
      if (offline) throw new Error("offline");
      appended.push(value);
    } } });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed" });
    expect(harness.reservations[0]?.settled).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({ outcome: "failure", charged: true });
    offline = false;
    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "completed" });
    expect(harness.extractor.extract).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(await harness.repository.getAutomaticOutbox(LOCAL_USER, input.sourceMessageId)).toBeNull();
  });

  it("resumes a plan after the durable outbox response is lost", async () => {
    const harness = createHarness();
    const save = harness.repository.saveAutomaticOutbox.bind(harness.repository);
    let loseResponse = true;
    vi.spyOn(harness.repository, "saveAutomaticOutbox").mockImplementation(async (...args) => {
      const stored = await save(...args);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return stored;
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed" });
    const receipt = await harness.repository.getAutomaticProcessing(LOCAL_USER, input.sourceMessageId);
    expect(receipt).not.toHaveProperty("actionPlan");
    expect(JSON.stringify(receipt)).not.toContain(input.turns[0].text);

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "completed" });
    expect(harness.extractor.extract).toHaveBeenCalledOnce();
    expect(harness.usage).toHaveLength(1);
    expect(new Set(harness.reservations.map((entry) => entry.requestId))).toHaveLength(1);
  });

  it("retries cost settlement with one logical ledger row and no second extraction", async () => {
    const ledger = new Map<string, unknown>();
    let settlementAttempts = 0;
    const requestIds: string[] = [];
    const harness = createHarness({
      usageLog: { append: async (_user, value) => {
        const row = value as { sessionId: string };
        ledger.set(row.sessionId, row);
      } },
      costGuard: {
        reserve: async ({ requestId }) => {
          requestIds.push(requestId);
          return {
            requestId,
            settle: async () => {
              settlementAttempts += 1;
              if (settlementAttempts === 1) throw new Error("settlement unavailable");
            },
            hold: async () => undefined,
          };
        },
      },
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed" });
    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "completed" });

    expect(harness.extractor.extract).toHaveBeenCalledOnce();
    expect(ledger.size).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(new Set(requestIds)).toHaveLength(1);
  });

  it("accounts every dispatched provider attempt while keeping one mutation plan", async () => {
    let attempts = 0;
    const source: MemoryExtractor = {
      extract: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary");
        return {
          candidates: [],
          actions: [add("朝は紅茶を飲むのが好き")],
          usage: { memoryInputTokens: 10, memoryCachedInputTokens: 0, memoryCacheWriteTokens: 0, memoryOutputTokens: 2 },
        };
      }),
    };
    const harness = createHarness({ extractor: source });

    await harness.processor.process(LOCAL_USER, input);
    await harness.processor.process(LOCAL_USER, input);
    await harness.processor.process(LOCAL_USER, input);

    expect(harness.events.map((event) => event.outcome)).toContain("retry");
    expect(new Set(harness.reservations.map((reservation) => reservation.requestId))).toHaveLength(3);
    expect(harness.reservations.map((reservation) => reservation.held)).toEqual([1, 1, 0]);
    expect(new Set((harness.usage as Array<{ sessionId: string }>).map((entry) => entry.sessionId))).toHaveLength(1);
    expect(await harness.repository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("holds a dispatched timeout attempt conservatively without persisting its error or turns", async () => {
    const source: MemoryExtractor = { extract: vi.fn(async () => { throw new OpenAI.APIConnectionTimeoutError(); }) };
    const harness = createHarness({ extractor: source });

    await harness.processor.process(LOCAL_USER, input);

    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]?.held).toBe(1);
    expect(harness.events.at(-1)).toMatchObject({ outcome: "timeout", charged: true });
    expect(JSON.stringify(await harness.repository.getLatestAutomaticExtractionAttempt(LOCAL_USER, input.sourceMessageId))).not.toContain(input.turns[0].text);
  });

  it("resumes after restart with a new charged attempt following a lost provider response", async () => {
    const source = extractor([]);
    (source.extract as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
      .mockResolvedValueOnce({ candidates: [], actions: [add("朝は紅茶が好き")], usage: {
        memoryInputTokens: 10, memoryCachedInputTokens: 0, memoryCacheWriteTokens: 0, memoryOutputTokens: 2,
      } });
    const harness = createHarness({ extractor: source });

    await harness.processor.process(LOCAL_USER, input);
    const restarted = new MemoryProcessor({
      extractor: source,
      repository: harness.repository,
      usageLog: harness.usageLog,
      costGuard: harness.costGuard,
      maximumUsd: 0.1,
      now: () => new Date(occurredAt),
    });
    await restarted.process(LOCAL_USER, input);

    expect(source.extract).toHaveBeenCalledTimes(2);
    expect(new Set(harness.reservations.map((entry) => entry.requestId))).toHaveLength(2);
    expect(harness.reservations.map((entry) => entry.held)).toEqual([1, 0]);
    expect(await harness.repository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("holds the failed attempt and settles a separate successful retry", async () => {
    const reservationStates = new Map<string, "reserved" | "held" | "settled">();
    let settlements = 0;
    const requestIds: string[] = [];
    const costGuard: CostGuard = {
      reserve: async ({ requestId }) => {
        requestIds.push(requestId);
        if (!reservationStates.has(requestId)) reservationStates.set(requestId, "reserved");
        return {
          requestId,
          settle: async () => {
            if (reservationStates.get(requestId) === "reserved") {
              reservationStates.set(requestId, "settled");
              settlements += 1;
            }
          },
          hold: async () => { if (reservationStates.get(requestId) === "reserved") reservationStates.set(requestId, "held"); },
        };
      },
    };
    let attempts = 0;
    const source: MemoryExtractor = {
      extract: vi.fn(async () => {
        if (attempts++ === 0) throw new Error("temporary");
        return {
          candidates: [],
          actions: [add("朝は紅茶が好き")],
          usage: { memoryInputTokens: 10, memoryCachedInputTokens: 0, memoryCacheWriteTokens: 0, memoryOutputTokens: 2 },
        };
      }),
    };
    const harness = createHarness({ extractor: source, costGuard });

    await harness.processor.process(LOCAL_USER, input);
    await harness.processor.process(LOCAL_USER, input);

    expect([...reservationStates.values()]).toEqual(["held", "settled"]);
    expect(settlements).toBe(1);
    expect(new Set(requestIds)).toHaveLength(2);
  });

  it("reuses the durable action plan after a lost completion response", async () => {
    let extractions = 0;
    const source = extractor([]);
    (source.extract as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      candidates: [],
      actions: extractions++ === 0
        ? [add("朝は紅茶が好き"), add("夜は読書をする")]
        : [add("別の候補に変わった")],
      usage: { memoryInputTokens: 10, memoryCachedInputTokens: 0, memoryCacheWriteTokens: 0, memoryOutputTokens: 2 },
    }));
    const harness = createHarness({ extractor: source });
    const finish = harness.repository.setAutomaticProcessing.bind(harness.repository);
    let loseCompletion = true;
    vi.spyOn(harness.repository, "setAutomaticProcessing").mockImplementation(async (user, sourceMessageId, state, appliedCount) => {
      if (state === "completed" && loseCompletion) {
        loseCompletion = false;
        await finish(user, sourceMessageId, state, appliedCount);
        throw new Error("response lost");
      }
      await finish(user, sourceMessageId, state, appliedCount);
    });

    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "failed", appliedCount: 2 });
    await expect(harness.processor.process(LOCAL_USER, input)).resolves.toMatchObject({ state: "completed", appliedCount: 2 });

    expect(source.extract).toHaveBeenCalledOnce();
    expect((await harness.repository.list(LOCAL_USER)).map((memory) => memory.content).sort()).toEqual(["夜は読書をする", "朝は紅茶が好き"].sort());
  });
});
