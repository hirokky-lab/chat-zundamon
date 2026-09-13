import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { createProfileRepository } from "../src/profile-db";
import { LOCAL_USER } from "../src/request-user";

const noMemoryExtractor = {
  extract: async () => ({ candidates: [] }),
};

describe("profile routes", () => {
  it("returns a null profile before setup", async () => {
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: createProfileRepository(":memory:"),
    });

    const response = await app.inject({ method: "GET", url: "/api/profile" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profile: null });
  });

  it("normalizes a display name and returns the saved profile", async () => {
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: createProfileRepository(
        ":memory:",
        () => new Date("2026-08-08T03:00:00.000Z"),
      ),
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { displayName: "大輝です", addressingStyle: "none" },
    });
    const loaded = await app.inject({ method: "GET", url: "/api/profile" });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      profile: {
        displayName: "大輝",
        addressingStyle: "none",
        updatedAt: "2026-08-08T03:00:00.000Z",
      },
    });
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(loaded.headers["cache-control"]).toBe("no-store");
    expect(loaded.json()).toEqual(saved.json());
  });

  it("rejects invalid profile requests without overwriting the saved profile or exposing API keys", async () => {
    const repository = createProfileRepository(":memory:");
    await repository.save(LOCAL_USER, { displayName: "大輝", addressingStyle: "san" });
    const logLines: string[] = [];
    const app = buildApp({
      extractor: noMemoryExtractor,
      logger: {
        level: "info",
        stream: { write: (line: string) => logLines.push(line) },
      },
      profileRepository: repository,
    });

    for (const payload of [
      { displayName: "大輝ですがよろしく", addressingStyle: "san" },
      { displayName: "大輝\u0000", addressingStyle: "san" },
      { displayName: "大輝\n", addressingStyle: "san" },
      { displayName: "   ", addressingStyle: "san" },
      { displayName: "あいうえおかきくけこさしすせそたちつてとな", addressingStyle: "san" },
      { displayName: "大輝" },
      { displayName: "大輝", addressingStyle: "chan" },
      { displayName: "大輝", addressingStyle: "none" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/profile",
        payload: {
          ...payload,
          apiKey: "OPENAI_API_KEY=server-only-secret",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_profile" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("server-only-secret");
    }

    expect(await repository.get(LOCAL_USER)).toMatchObject({ displayName: "大輝", addressingStyle: "san" });
    expect(logLines.join("\n")).not.toContain("server-only-secret");
  });
});

it("persists optional personal details, preserves omitted fields and clears explicit empty values", async () => {
  const repository = createProfileRepository(":memory:");
  const app = buildApp({ extractor: noMemoryExtractor, profileRepository: repository });
  const save = (details: Record<string, unknown>) => app.inject({method:"PUT", url:"/api/profile", payload:{displayName:"テスト", addressingStyle:"san", ...details}});
  expect((await save({occupation:"  企画  ", region:"東京都"})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:"/api/profile"})).json().profile).toMatchObject({occupation:"企画",region:"東京都"});
  await save({displayName:"別名"});
  expect(await repository.get(LOCAL_USER)).toMatchObject({occupation:"企画",region:"東京都"});
  expect((await save({region:"x".repeat(121)})).statusCode).toBe(400);
  await save({occupation:"",region:""});
  expect(await repository.get(LOCAL_USER)).toMatchObject({occupation:"",region:""});
  await app.close();
});
