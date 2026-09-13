import { describe, expect, it, vi } from "vitest";
import jpeg from "jpeg-js";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { OpenAIPhotoAnalysisGateway, analyzePreparedPhoto, buildPhotoReceipt, estimatePhotoAnalysisUsd, processPhotoCleanup, readPhotoMultipart, reconcilePhotoStorage, registerPhotoRoutes } from "../src/photo.js";
import type { PhotoRepository, PhotoRequestRecord } from "../src/photo-repository.js";
import { createWriteGate } from "../src/write-gate.js";

const messageId = "11111111-1111-4111-8111-111111111111";

describe("photo Responses gateway", () => {
  it("settles only bounded, complete photo usage at the fixed six-decimal price", () => {
    expect(estimatePhotoAnalysisUsd({ inputTokens: 1000, cachedTokens: 200, cacheWriteTokens: 100, outputTokens: 50 })).toBe(0.001145);
    expect(() => estimatePhotoAnalysisUsd({ inputTokens: 272001, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })).toThrow("photo_usage_out_of_bounds");
    expect(() => estimatePhotoAnalysisUsd({ inputTokens: 10, cachedTokens: 5, cacheWriteTokens: 6, outputTokens: 1 })).toThrow("photo_usage_out_of_bounds");
  });

  it("dispatches one low-detail inline JPEG with retries disabled and strict null memory fields", async () => {
    const create = vi.fn(async () => ({ output_text: JSON.stringify({ bubbles: ["きれいな空だね"], profileUpdate: null, memoryAction: null }), usage: { input_tokens: 10, output_tokens: 4 } }));
    const gateway = new OpenAIPhotoAnalysisGateway({ responses: { create } });
    const signal = new AbortController().signal;
    await expect(gateway.analyze({ jpeg: Buffer.from([1, 2]), caption: "見て", signal, idempotencyKey: messageId, model: "gpt-5.6-luna" }))
      .resolves.toMatchObject({ bubbles: ["きれいな空だね"] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-luna", store: false, background: false, service_tier: "default", max_output_tokens: 300,
      input: [{ role: "user", content: [
        { type: "input_text", text: expect.stringContaining("見て") },
        { type: "input_image", image_url: "data:image/jpeg;base64,AQI=", detail: "low" },
      ] }],
      text: { format: { type: "json_schema", name: "yui_photo_reply", strict: true, schema: expect.objectContaining({ additionalProperties: false }) } },
    }), { signal, maxRetries: 0 });
  });

  it.each([
    { bubbles: [], profileUpdate: null, memoryAction: null },
    { bubbles: ["ok"], profileUpdate: {}, memoryAction: null },
    { bubbles: ["ok"], profileUpdate: null, memoryAction: { type: "add" } },
    { bubbles: ["ok", "ok", "ok", "four"], profileUpdate: null, memoryAction: null },
  ])("rejects invalid or memory-bearing provider output", async (body) => {
    const gateway = new OpenAIPhotoAnalysisGateway({ responses: { create: async () => ({ output_text: JSON.stringify(body) }) } });
    await expect(gateway.analyze({ jpeg: Buffer.from([1]), caption: "", signal: new AbortController().signal, idempotencyKey: messageId, model: "gpt-5.6-luna" }))
      .rejects.toThrow("photo_invalid_response");
  });

  it("constructs every durable receipt field from authoritative server metadata", () => {
    expect(buildPhotoReceipt({ clientMessageId: messageId, bubbles: ["一つ", "二つ"], createdAt: "2026-08-13T00:00:00.000Z" })).toEqual({
      photo: { id: messageId, createdAt: "2026-08-13T00:00:00.000Z", delivery: "sent" },
      replyGroupId: `${messageId}:assistant`,
      bubbles: [
        { id: `${messageId}:assistant:0`, text: "一つ", createdAt: "2026-08-13T00:00:00.000Z", sequence: 0, delivery: "sent", origin: "photo_analysis", sourcePhotoMessageId: messageId },
        { id: `${messageId}:assistant:1`, text: "二つ", createdAt: "2026-08-13T00:00:00.000Z", sequence: 1, delivery: "sent", origin: "photo_analysis", sourcePhotoMessageId: messageId },
      ],
    });
  });

  it.each([
    ["timeout", Object.assign(new Error("secret timeout"), { name: "TimeoutError" }), "photo_upstream_timeout"],
    ["network", new Error("secret network"), "photo_upstream_unavailable"],
    ["429", Object.assign(new Error("secret 429"), { status: 429 }), "photo_upstream_unavailable"],
    ["5xx", Object.assign(new Error("secret 500"), { status: 500 }), "photo_upstream_unavailable"],
  ])("maps %s with one dispatch and no provider body", async (_kind, failure, expected) => {
    const create = vi.fn(async () => { throw failure; });
    const gateway = new OpenAIPhotoAnalysisGateway({ responses: { create } });
    await expect(gateway.analyze({ jpeg: Buffer.from([1]), caption: "secret caption", signal: new AbortController().signal, idempotencyKey: messageId, model: "gpt-5.6-luna" })).rejects.toThrow(expected);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("durable photo orchestration", () => {
  it.each([
    ["claim_rpc", "claim"],
    ["storage_upload", "storage"],
    ["analysis_dispatch", "dispatch"],
    ["analysis_complete_rpc", "complete"],
  ] as const)("reports only the fixed %s stage when %s fails", async (expectedStage, failingBoundary) => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = {
      ownerId: messageId, clientMessageId: messageId, photoId,
      requestState: failingBoundary === "storage" ? "claimed" : "uploaded",
      analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null,
      leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z",
    };
    const secret = `PRIVATE_${failingBoundary.toUpperCase()}_BODY`;
    const repository = {
      claim: vi.fn(async () => {
        if (failingBoundary === "claim") throw new Error(secret);
        return uploaded;
      }),
      beginUpload: vi.fn(async () => ({ ...uploaded, requestState: "uploading" as const })),
      completeUpload: vi.fn(async () => ({ ...uploaded, requestState: "uploaded" as const })),
      claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing" as const, analysisState: "dispatched" as const })),
      complete: vi.fn(async (input) => {
        if (failingBoundary === "complete") throw new Error(secret);
        return { ...uploaded, requestState: "succeeded" as const, analysisState: "succeeded" as const, receipt: input.receipt };
      }),
      fail: vi.fn(async () => ({ ...uploaded, requestState: "ambiguous" as const, analysisState: "ambiguous" as const })),
    } as unknown as PhotoRepository;
    const storage = {
      exists: vi.fn(async () => {
        if (failingBoundary === "storage") throw new Error(secret);
        return false;
      }),
      put: vi.fn(async () => undefined), open: vi.fn(), list: vi.fn(), remove: vi.fn(),
    };
    const gateway = {
      analyze: vi.fn(async () => {
        if (failingBoundary === "dispatch") throw new Error(secret);
        return { bubbles: ["ok"] };
      }),
    };
    const onDiagnostic = vi.fn(async () => undefined);

    await expect(analyzePreparedPhoto({
      ownerId: messageId, clientMessageId: messageId, caption: "private caption", jpeg: jpegBytes,
      signal: new AbortController().signal, repository, storage, gateway, writeGate: createWriteGate(),
      leaseOwner: "worker", now: () => new Date("2026-08-13T00:00:00.000Z"), onDiagnostic,
    } as never)).rejects.toThrow(secret);

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({ feature: "photo", stage: expectedStage, status: "unavailable" });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private caption");
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(messageId);
  });

  it("keeps the original failure and emits nothing else when the diagnostic sink fails", async () => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    const repository = { claim: vi.fn(async () => { throw new Error("PRIVATE_DB_ERROR"); }) } as unknown as PhotoRepository;
    const onDiagnostic = vi.fn(async () => { throw new Error("PRIVATE_SINK_ERROR"); });

    await expect(analyzePreparedPhoto({
      ownerId: messageId, clientMessageId: messageId, caption: "private caption", jpeg: jpegBytes,
      signal: new AbortController().signal, repository, storage: {} as never, gateway: {} as never,
      writeGate: createWriteGate(), onDiagnostic,
    } as never)).rejects.toThrow("PRIVATE_DB_ERROR");
    expect(onDiagnostic).toHaveBeenCalledWith({ feature: "photo", stage: "claim_rpc", status: "unavailable" });
  });

  it("rejects a missing or closed write gate before claim, storage, provider egress, or persistence", async () => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    const repository = { claim: vi.fn() } as unknown as PhotoRepository;
    const storage = { put: vi.fn(), exists: vi.fn(), open: vi.fn() };
    const gateway = { analyze: vi.fn() };
    const base = { ownerId: messageId, clientMessageId: messageId, caption: "", jpeg: jpegBytes, signal: new AbortController().signal, repository, storage, gateway };
    await expect(analyzePreparedPhoto(base as never)).rejects.toThrow("photo_maintenance");
    const gate = createWriteGate();
    gate.closeForRestore();
    await expect(analyzePreparedPhoto({ ...base, writeGate: gate } as never)).rejects.toThrow("photo_maintenance");
    expect(repository.claim).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(gateway.analyze).not.toHaveBeenCalled();
  });

  it("dispatches once across matching retries and returns only the server-authored receipt", async () => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    let row: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId: "22222222-2222-4222-8222-222222222222", requestState: "claimed", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const repository: PhotoRepository = {
      claim: vi.fn(async () => row), beginUpload: vi.fn(async () => (row = { ...row, requestState: "uploading" })),
      completeUpload: vi.fn(async () => (row = { ...row, requestState: "uploaded" })),
      claimAnalysis: vi.fn(async () => (row = { ...row, requestState: "analyzing", analysisState: "dispatched" })),
      complete: vi.fn(async (input) => (row = { ...row, requestState: "succeeded", analysisState: "succeeded", receipt: input.receipt })),
      fail: vi.fn(async () => (row = { ...row, requestState: "ambiguous", analysisState: "ambiguous" })),
      getActive: vi.fn(async () => null),
    };
    let stored: Uint8Array | null = null;
    const storage = {
      put: vi.fn(async (_path: string, bytes: Uint8Array) => { stored = bytes; }), exists: vi.fn(async () => stored !== null), remove: vi.fn(async () => undefined),
      open: vi.fn(async () => ({ body: Readable.from(Buffer.from(stored!)), byteSize: stored!.byteLength, contentType: "image/jpeg" as const })),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    const gateway = { analyze: vi.fn(async () => ({ bubbles: ["見えたよ"], usage: { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } })) };
    const options = { ownerId: messageId, clientMessageId: messageId, caption: "見て", jpeg: jpegBytes, signal: new AbortController().signal, repository, storage, gateway, writeGate: createWriteGate(), leaseOwner: "worker", now: () => new Date("2026-08-13T00:00:00.000Z") };
    const first = await analyzePreparedPhoto(options);
    const retry = await analyzePreparedPhoto(options);
    expect(gateway.analyze).toHaveBeenCalledTimes(1);
    expect(first).toEqual(retry);
    expect(first.reply.bubbles[0]).toMatchObject({ text: "見えたよ", origin: "photo_analysis", sourcePhotoMessageId: messageId });
    expect(JSON.stringify(first)).not.toContain("profileUpdate");
    expect(JSON.stringify(first)).not.toContain("memoryAction");
  });

  it("marks a dispatched provider failure ambiguous and never retries it", async () => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    let row: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId: "22222222-2222-4222-8222-222222222222", requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const repository = {
      claim: vi.fn(async () => row), beginUpload: vi.fn(), completeUpload: vi.fn(),
      claimAnalysis: vi.fn(async () => (row = { ...row, requestState: "analyzing", analysisState: "dispatched" })), complete: vi.fn(),
      fail: vi.fn(async () => (row = { ...row, requestState: "ambiguous", analysisState: "ambiguous" })),
      getActive: vi.fn(async () => null),
    } as unknown as PhotoRepository;
    const gateway = { analyze: vi.fn(async () => { throw new Error("provider secret"); }) };
    const options = { ownerId: messageId, clientMessageId: messageId, caption: "", jpeg: jpegBytes, signal: new AbortController().signal, repository, storage: { exists: vi.fn(), put: vi.fn(), open: vi.fn(), list: vi.fn(), remove: vi.fn() }, gateway, writeGate: createWriteGate(), leaseOwner: "worker" } as Parameters<typeof analyzePreparedPhoto>[0];
    await expect(analyzePreparedPhoto(options)).rejects.toThrow("provider secret");
    await expect(analyzePreparedPhoto(options)).rejects.toThrow("photo_analysis_ambiguous");
    expect(gateway.analyze).toHaveBeenCalledTimes(1);
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ ambiguous: true }));
  });

  it("holds an out-of-bounds provider usage before durable completion", async () => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    const row: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId: "22222222-2222-4222-8222-222222222222", requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const complete = vi.fn();
    const repository = {
      claim: vi.fn(async () => row), claimAnalysis: vi.fn(async () => ({ ...row, requestState: "analyzing", analysisState: "dispatched" })), complete,
      fail: vi.fn(async () => ({ ...row, requestState: "ambiguous", analysisState: "ambiguous" })),
    } as unknown as PhotoRepository;
    const options = {
      ownerId: messageId, clientMessageId: messageId, caption: "", jpeg: jpegBytes, signal: new AbortController().signal, repository,
      storage: { exists: vi.fn(), put: vi.fn(), open: vi.fn(), list: vi.fn(), remove: vi.fn() },
      gateway: { analyze: vi.fn(async () => ({ bubbles: ["ok"], usage: { inputTokens: 1, cachedTokens: 2, cacheWriteTokens: 0, outputTokens: 1 } })) },
      writeGate: createWriteGate(), leaseOwner: "worker", onUsage: vi.fn(async () => undefined),
    } as Parameters<typeof analyzePreparedPhoto>[0];

    await expect(analyzePreparedPhoto(options)).rejects.toThrow("photo_usage_out_of_bounds");
    expect(complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ ambiguous: true }));
  });

  it.each(["claimed", "uploading", "uploaded"] as const)("resumes the durable %s crash window without a second dispatch", async (initialState) => {
    const jpegBytes = jpeg.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }, 90).data;
    const photoId = "22222222-2222-4222-8222-222222222222";
    let row: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId, requestState: initialState, analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const repository = {
      claim: vi.fn(async () => row), beginUpload: vi.fn(async () => (row = { ...row, requestState: "uploading" })),
      completeUpload: vi.fn(async () => (row = { ...row, requestState: "uploaded" })),
      claimAnalysis: vi.fn(async () => (row = { ...row, requestState: "analyzing", analysisState: "dispatched" })),
      complete: vi.fn(async (input) => (row = { ...row, requestState: "succeeded", analysisState: "succeeded", receipt: input.receipt })),
      fail: vi.fn(), getActive: vi.fn(), claimCleanup: vi.fn(), markVerified: vi.fn(), getStorageScanCursor: vi.fn(), saveStorageScanCursor: vi.fn(), registerOrphan: vi.fn(),
    } as unknown as PhotoRepository;
    const stored = initialState === "uploading" ? jpegBytes : null;
    const storage = {
      exists: vi.fn(async () => stored !== null), put: vi.fn(async () => undefined),
      open: vi.fn(async () => ({ body: Readable.from(Buffer.from(stored!)), byteSize: stored!.byteLength, contentType: "image/jpeg" as const })),
      remove: vi.fn(), list: vi.fn(),
    };
    const gateway = { analyze: vi.fn(async () => ({ bubbles: ["ok"] })) };
    await expect(analyzePreparedPhoto({ ownerId: messageId, clientMessageId: messageId, caption: "", jpeg: jpegBytes, signal: new AbortController().signal, repository, storage, gateway, writeGate: createWriteGate(), leaseOwner: "worker", now: () => new Date("2026-08-13T00:00:00.000Z") })).resolves.toBeDefined();
    expect(gateway.analyze).toHaveBeenCalledOnce();
    if (initialState === "uploaded") expect(storage.exists).not.toHaveBeenCalled();
  });
});

describe("photo route", () => {
  const multipartBody = (parts: Array<{ name: string; value?: string; file?: Buffer }>) => {
    const boundary = "----photo-review-boundary";
    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat([...parts.flatMap((part) => part.file ? [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), part.file, Buffer.from("\r\n"),
      ] : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ""}\r\n`)]), Buffer.from(`--${boundary}--\r\n`)]),
    };
  };
  it("returns disabled before constructing a multipart iterator, repository, storage, or gateway", async () => {
    const app = Fastify();
    app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const repository = { claim: vi.fn() } as unknown as PhotoRepository;
    const storage = { put: vi.fn() };
    const gateway = { analyze: vi.fn() };
    registerPhotoRoutes(app, { enabled: () => false, repository, storage: storage as never, gateway, writeGate: createWriteGate() });
    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(6 * 1024 * 1024) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "photo_disabled", code: "photo_disabled" });
    expect(repository.claim).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(gateway.analyze).not.toHaveBeenCalled();
    await app.close();
  });

  it("reserves the image ceiling before dispatch and settles only validated provider usage", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId, requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const complete = vi.fn(async (input) => ({ ...uploaded, requestState: "succeeded", analysisState: "succeeded", receipt: input.receipt }));
    const repository = {
      claim: vi.fn(async () => uploaded),
      claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing", analysisState: "dispatched" })),
      complete,
      fail: vi.fn(),
    } as unknown as PhotoRepository;
    const settle = vi.fn(async () => undefined);
    const reserve = vi.fn(async () => ({ requestId: "photo", settle, hold: vi.fn(async () => undefined) }));
    registerPhotoRoutes(app, {
      enabled: () => true, repository, storage: {} as never,
      gateway: { analyze: vi.fn(async () => ({ bubbles: ["ok"], usage: { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } })) },
      writeGate: createWriteGate(), costGuard: { reserve }, maximumUsd: 0.10,
    });
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    const body = multipartBody([{ name: "clientMessageId", value: messageId }, { name: "caption", value: "" }, { name: "photo", file: photo }]);
    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ feature: "image", maximumUsd: 0.10 }));
    expect(settle).toHaveBeenCalledWith(0.000007);
    expect(complete).toHaveBeenCalledBefore(settle);
  });

  it("aborts photo analysis before the platform deadline and holds its reservation", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId, requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const repository = {
      claim: vi.fn(async () => uploaded),
      claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing", analysisState: "dispatched" })),
      fail: vi.fn(async () => ({ ...uploaded, requestState: "ambiguous", analysisState: "ambiguous" })),
    } as unknown as PhotoRepository;
    const hold = vi.fn(async () => undefined);
    const gateway = { analyze: vi.fn(async () => new Promise<never>(() => undefined)) };
    registerPhotoRoutes(app, {
      enabled: () => true, repository, storage: {} as never, gateway, writeGate: createWriteGate(),
      costGuard: { reserve: vi.fn(async () => ({ requestId: "photo", settle: vi.fn(), hold })) }, maximumUsd: 0.10,
      analysisTimeoutMs: 100,
    } as never);
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    const body = multipartBody([{ name: "clientMessageId", value: messageId }, { name: "caption", value: "" }, { name: "photo", file: photo }]);

    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: "photo_upstream_timeout", code: "photo_upstream_timeout" });
    expect(gateway.analyze).toHaveBeenCalledOnce();
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ ambiguous: true }));
    expect(hold).toHaveBeenCalledOnce();
  }, 1_000);

  it("holds its reservation when a dispatched analysis becomes ambiguous", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId, requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const repository = {
      claim: vi.fn(async () => uploaded),
      claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing", analysisState: "dispatched" })),
      fail: vi.fn(async () => ({ ...uploaded, requestState: "ambiguous", analysisState: "ambiguous" })),
    } as unknown as PhotoRepository;
    const hold = vi.fn(async () => undefined);
    registerPhotoRoutes(app, {
      enabled: () => true, repository, storage: {} as never,
      gateway: { analyze: vi.fn(async () => { throw new Error("photo_analysis_ambiguous"); }) },
      writeGate: createWriteGate(), costGuard: { reserve: vi.fn(async () => ({ requestId: "photo", settle: vi.fn(), hold })) }, maximumUsd: 0.10,
    } as never);
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    const body = multipartBody([{ name: "clientMessageId", value: messageId }, { name: "caption", value: "" }, { name: "photo", file: photo }]);

    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "photo_analysis_ambiguous", code: "photo_analysis_ambiguous" });
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ ambiguous: true }));
    expect(hold).toHaveBeenCalledOnce();
  });

  it("leaves a durable success available for cost reconciliation when settlement fails", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = { ownerId: messageId, clientMessageId: messageId, photoId, requestState: "uploaded", analysisState: "not_dispatched", deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z" };
    const complete = vi.fn(async (input) => ({ ...uploaded, requestState: "succeeded", analysisState: "succeeded", receipt: input.receipt, usage: input.usage }));
    const repository = {
      claim: vi.fn(async () => uploaded), claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing", analysisState: "dispatched" })), complete,
      fail: vi.fn(),
    } as unknown as PhotoRepository;
    const settle = vi.fn(async () => { throw new Error("cost_backend_unavailable"); });
    const hold = vi.fn(async () => undefined);
    registerPhotoRoutes(app, {
      enabled: () => true, repository, storage: {} as never,
      gateway: { analyze: vi.fn(async () => ({ bubbles: ["ok"], usage: { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } })) },
      writeGate: createWriteGate(), costGuard: { reserve: vi.fn(async () => ({ requestId: "photo", settle, hold })) }, maximumUsd: 0.10,
    } as never);
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    const body = multipartBody([{ name: "clientMessageId", value: messageId }, { name: "caption", value: "" }, { name: "photo", file: photo }]);

    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "photo_cost_reconciliation_pending", code: "photo_cost_reconciliation_pending" });
    expect(complete).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(hold).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("reports only the fixed cost reservation stage when image accounting is unavailable", async () => {
    const logLines: string[] = [];
    const app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { logLines.push(line); } } } });
    app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const repository = { claim: vi.fn() } as unknown as PhotoRepository;
    const privateCostError = "PRIVATE_COST_BACKEND_BODY_4f91";
    const captionSecret = "PRIVATE_CAPTION_2b18"; // gitleaks:allow -- synthetic unit-test fixture, never a real credential
    registerPhotoRoutes(app, {
      enabled: () => true,
      repository,
      storage: {} as never,
      gateway: { analyze: vi.fn() },
      writeGate: createWriteGate(),
      costGuard: { reserve: vi.fn(async () => { throw new Error(privateCostError); }) },
      maximumUsd: 0.10,
    });
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    const body = multipartBody([
      { name: "clientMessageId", value: messageId },
      { name: "caption", value: captionSecret },
      { name: "photo", file: photo },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();

    expect(response.statusCode).toBe(502);
    expect(repository.claim).not.toHaveBeenCalled();
    const captured = logLines.join("\n");
    expect(captured).toContain('"feature":"photo"');
    expect(captured).toContain('"stage":"cost_reservation"');
    expect(captured).toContain('"status":"unavailable"');
    expect(captured).not.toContain(privateCostError);
    expect(captured).not.toContain(captionSecret);
    expect(captured).not.toContain(photo.toString("base64"));
  });

  it("sets private no-store headers on invalid, missing, blocked, and unavailable content responses", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const repository = { getActive: vi.fn(async () => null) } as unknown as PhotoRepository;
    registerPhotoRoutes(app, { enabled: () => true, repository, storage: { open: vi.fn() } as never, gateway: { analyze: vi.fn() }, writeGate: createWriteGate() });
    for (const id of ["bad", "22222222-2222-4222-8222-222222222222"]) {
      const response = await app.inject({ method: "GET", url: `/api/photos/${id}/content` });
      expect(response.headers).toMatchObject({ "cache-control": "private, no-store, max-age=0", pragma: "no-cache", "x-content-type-options": "nosniff" });
    }
    await app.close();
  });

  it.each([
    ["unknown field before file", [{ name: "unknown", value: "x" }, { name: "photo", file: Buffer.from([1]) }]],
    ["duplicate field before file", [{ name: "caption", value: "a" }, { name: "caption", value: "b" }, { name: "photo", file: Buffer.from([1]) }]],
    ["second file", [{ name: "photo", file: Buffer.from([1]) }, { name: "photo", file: Buffer.from([2]) }]],
  ])("drains and rejects every multipart part for %s", async (_name, parts) => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const repository = { claim: vi.fn() } as unknown as PhotoRepository;
    registerPhotoRoutes(app, { enabled: () => true, repository, storage: {} as never, gateway: { analyze: vi.fn() }, writeGate: createWriteGate() });
    const body = multipartBody(parts as Array<{ name: string; value?: string; file?: Buffer }>);
    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    expect(response.statusCode).toBe(400);
    expect(repository.claim).not.toHaveBeenCalled();
    await app.close();
  });

  it("observably consumes a later file stream after an earlier invalid part", async () => {
    const later = Readable.from(Buffer.from("sensitive jpeg sentinel"));
    const parts = async function* () {
      yield { type: "field", fieldname: "unknown", value: "x" };
      yield { type: "file", fieldname: "photo", filename: "photo.jpg", mimetype: "image/jpeg", file: later };
    };
    await expect(readPhotoMultipart({ parts: () => parts() } as never)).rejects.toThrow("invalid_photo_request");
    expect(later.readableEnded).toBe(true);
  });

  it("does not log the caption, JPEG body, or provider error body", async () => {
    const logLines: string[] = [];
    const app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { logLines.push(line); } } } });
    app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const photoId = "22222222-2222-4222-8222-222222222222";
    const uploaded: PhotoRequestRecord = {
      ownerId: messageId, clientMessageId: messageId, photoId, requestState: "uploaded", analysisState: "not_dispatched",
      deletionState: null, receipt: null, usage: null, leaseOwner: "worker", leaseExpiresAt: "2026-08-13T00:02:00.000Z",
    };
    const repository = {
      claim: vi.fn(async () => uploaded), beginUpload: vi.fn(), completeUpload: vi.fn(),
      claimAnalysis: vi.fn(async () => ({ ...uploaded, requestState: "analyzing", analysisState: "dispatched" })),
      complete: vi.fn(), fail: vi.fn(async () => ({ ...uploaded, requestState: "ambiguous", analysisState: "ambiguous" })),
    } as unknown as PhotoRepository;
    const providerSecret = "PRIVATE_PROVIDER_BODY_9f2a";
    const captionSecret = "PRIVATE_CAPTION_7e1b"; // gitleaks:allow -- synthetic unit-test fixture, never a real credential
    const photo = jpeg.encode({ width: 1, height: 1, data: Buffer.from([23, 47, 91, 255]) }, 90).data;
    registerPhotoRoutes(app, {
      enabled: () => true, repository, storage: {} as never,
      gateway: { analyze: vi.fn(async () => { throw new Error(providerSecret); }) }, writeGate: createWriteGate(),
    });
    const body = multipartBody([
      { name: "clientMessageId", value: messageId }, { name: "caption", value: captionSecret }, { name: "photo", file: photo },
    ]);
    const response = await app.inject({ method: "POST", url: "/api/photo-responses", headers: { "content-type": body.contentType }, payload: body.body });
    await app.close();
    expect(response.statusCode).toBe(502);
    const captured = logLines.join("\n");
    expect(captured).toContain('"feature":"photo"');
    expect(captured).toContain('"stage":"analysis_dispatch"');
    expect(captured).toContain('"status":"unavailable"');
    expect(captured).not.toContain(captionSecret);
    expect(captured).not.toContain(providerSecret);
    expect(captured).not.toContain(photo.toString("base64"));
  });

  it("streams only an active owner asset and rejects a byte-size mismatch with private headers", async () => {
    const app = Fastify(); app.decorateRequest("yuiUser");
    app.addHook("onRequest", async (request) => { request.yuiUser = { userId: messageId, email: "owner@yui.invalid", accessToken: "test" }; });
    const id = "22222222-2222-4222-8222-222222222222";
    const repository = { getActive: vi.fn(async () => ({ photoId: id, storagePath: `${messageId}/${id}.jpg`, byteSize: 2 })) } as unknown as PhotoRepository;
    const storage = { open: vi.fn(async () => ({ body: Readable.from(Buffer.from([1, 2])), byteSize: 2, contentType: "image/jpeg" as const })) };
    registerPhotoRoutes(app, { enabled: () => true, repository, storage: storage as never, gateway: { analyze: vi.fn() }, writeGate: createWriteGate() });
    const success = await app.inject({ method: "GET", url: `/api/photos/${id}/content` });
    expect(success.statusCode).toBe(200); expect(success.rawPayload).toEqual(Buffer.from([1, 2]));
    storage.open.mockResolvedValueOnce({ body: Readable.from(Buffer.from([1])), byteSize: 1, contentType: "image/jpeg" });
    const mismatch = await app.inject({ method: "GET", url: `/api/photos/${id}/content` });
    expect(mismatch.statusCode).toBe(503);
    expect(mismatch.headers["cache-control"]).toBe("private, no-store, max-age=0");
    await app.close();
  });
});

describe("photo reconciliation", () => {
  it("does not let cleanup claim work while restore has closed the write gate", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const repository = { claimCleanup: vi.fn(async () => []) } as unknown as PhotoRepository;
    await expect(processPhotoCleanup({ repository, storage: {} as never, leaseOwner: "cleanup", writeGate: gate } as never))
      .rejects.toThrow("photo_maintenance");
    expect(repository.claimCleanup).not.toHaveBeenCalled();
  });

  it("drains an in-flight cleanup lease before restore and blocks the next cleanup", async () => {
    const gate = createWriteGate();
    const job = { id: messageId, ownerId: messageId, photoId: "22222222-2222-4222-8222-222222222222", storagePath: `${messageId}/22222222-2222-4222-8222-222222222222.jpg`, state: "deleting" as const };
    let finishRemove!: () => void;
    const removeBarrier = new Promise<void>((resolve) => { finishRemove = resolve; });
    const repository = {
      claimCleanup: vi.fn(async () => [job]),
      markVerified: vi.fn(async () => ({ ...job, state: "verified" as const })),
    } as unknown as PhotoRepository;
    const storage = { remove: vi.fn(() => removeBarrier), exists: vi.fn(async () => false) } as never;
    const cleanup = processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate: gate });
    await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledOnce());
    gate.closeForRestore();
    let drained = false;
    const drain = gate.waitForDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishRemove();
    await cleanup;
    await drain;
    await expect(processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate: gate })).rejects.toThrow("photo_maintenance");
    expect(repository.claimCleanup).toHaveBeenCalledOnce();
  });

  it("paginates at 50, persists cursor, and treats 599999/600000ms inclusively", async () => {
    const created = (age: number) => new Date(Date.parse("2026-08-13T00:10:00.000Z") - age).toISOString() as `${string}Z`;
    const ids = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    const repository = { getStorageScanCursor: vi.fn(async () => "cursor-a"), registerOrphan: vi.fn(async () => true), saveStorageScanCursor: vi.fn(async () => undefined) } as unknown as PhotoRepository;
    const storage = { list: vi.fn()
      .mockResolvedValueOnce({ items: ids.map((id, index) => ({ path: `${messageId}/${id}.jpg`, createdAt: created(index ? 600_000 : 599_999) })), nextCursor: "cursor-b" })
      .mockResolvedValueOnce({ items: [], nextCursor: null }) } as never;
    await expect(reconcilePhotoStorage({ ownerId: messageId, repository, storage, now: new Date("2026-08-13T00:10:00.000Z"), writeGate: createWriteGate() })).resolves.toEqual({ scanned: 2, orphaned: 1, nextCursor: null });
    expect((storage as { list: ReturnType<typeof vi.fn> }).list).toHaveBeenNthCalledWith(1, { ownerPrefix: `${messageId}/`, cursor: "cursor-a", limit: 50 });
    expect(repository.registerOrphan).toHaveBeenCalledOnce();
    expect(repository.saveStorageScanCursor).toHaveBeenCalledWith({ ownerId: messageId, cursor: null });
  });

  it("claims at most 50 and converges remove/read-back crash windows", async () => {
    const jobs = [{ id: messageId, ownerId: messageId, photoId: "22222222-2222-4222-8222-222222222222", storagePath: `${messageId}/22222222-2222-4222-8222-222222222222.jpg`, state: "deleting" as const }];
    const repository = { claimCleanup: vi.fn(async () => jobs), markVerified: vi.fn(async (input) => ({ ...jobs[0], state: input.objectAbsent ? "verified" : "deleted" })) } as unknown as PhotoRepository;
    const storage = { remove: vi.fn(async () => undefined), exists: vi.fn(async () => false) } as never;
    await expect(processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate: createWriteGate() })).resolves.toEqual({ processed: 1, verified: 1 });
    expect(repository.claimCleanup).toHaveBeenCalledWith({ leaseOwner: "cleanup", limit: 50, leaseMs: 120_000 });
    expect(repository.markVerified).toHaveBeenCalledWith({ id: messageId, leaseOwner: "cleanup", objectAbsent: true });
  });

  it("keeps cleanup retryable when remove and existence read-back both fail", async () => {
    const job = { id: messageId, ownerId: messageId, photoId: "22222222-2222-4222-8222-222222222222", storagePath: `${messageId}/22222222-2222-4222-8222-222222222222.jpg`, state: "deleting" as const };
    const repository = { claimCleanup: vi.fn(async () => [job]), markVerified: vi.fn() } as unknown as PhotoRepository;
    const storage = { remove: vi.fn(async () => { throw new Error("remove unknown"); }), exists: vi.fn(async () => { throw new Error("read unknown"); }) } as never;
    await expect(processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate: createWriteGate() })).resolves.toEqual({ processed: 1, verified: 0 });
    expect(repository.markVerified).not.toHaveBeenCalled();
  });

  it("retries removal on the next cycle when a deleted job still has a storage object", async () => {
    const base = { id: messageId, ownerId: messageId, photoId: "22222222-2222-4222-8222-222222222222", storagePath: `${messageId}/22222222-2222-4222-8222-222222222222.jpg` };
    let job = { ...base, state: "deleting" as const };
    const repository = {
      claimCleanup: vi.fn(async () => [job]),
      markVerified: vi.fn(async (input: { objectAbsent: boolean }) => {
        job = { ...base, state: input.objectAbsent ? "verified" as const : "deleted" as const };
        return job;
      }),
    } as unknown as PhotoRepository;
    const storage = {
      remove: vi.fn(async () => undefined),
      exists: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    } as never;

    const writeGate = createWriteGate();
    await expect(processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate })).resolves.toEqual({ processed: 1, verified: 0 });
    expect(job.state).toBe("deleted");
    await expect(processPhotoCleanup({ repository, storage, leaseOwner: "cleanup", writeGate })).resolves.toEqual({ processed: 1, verified: 1 });
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(job.state).toBe("verified");
  });

  it("rejects a duplicate path returned across bounded storage pages", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const repository = { getStorageScanCursor: vi.fn(async () => null), getActive: vi.fn(async () => null), registerOrphan: vi.fn(async () => false), saveStorageScanCursor: vi.fn() } as unknown as PhotoRepository;
    const item = { path: `${messageId}/${id}.jpg`, createdAt: "2026-08-12T00:00:00.000Z" as const };
    const storage = { list: vi.fn().mockResolvedValueOnce({ items: [item], nextCursor: "two" }).mockResolvedValueOnce({ items: [item], nextCursor: null }) } as never;
    await expect(reconcilePhotoStorage({ ownerId: messageId, repository, storage, now: new Date("2026-08-13T00:10:00.000Z"), writeGate: createWriteGate() })).rejects.toThrow("invalid_photo_storage_response");
    expect(repository.saveStorageScanCursor).not.toHaveBeenCalled();
  });
});
