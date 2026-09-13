import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createProfileRepository } from "../src/profile-db";
import { LOCAL_USER, type RequestUser } from "../src/request-user";

const userA: RequestUser = { userId: "00000000-0000-0000-0000-00000000000a", email: "a@yui.invalid", accessToken: "a" };
const userB: RequestUser = { userId: "00000000-0000-0000-0000-00000000000b", email: "b@yui.invalid", accessToken: "b" };

describe("profile repository", () => {
  it("returns no profile before the first save", async () => {
    const repository = createProfileRepository(":memory:");

    expect(await repository.get(userA)).toBeNull();
  });

  it("isolates saved profiles by authenticated user", async () => {
    const repository = createProfileRepository(":memory:");
    await repository.save(userA, { displayName: "大輝", addressingStyle: "san" });

    expect(await repository.get(userB)).toBeNull();
    expect(await repository.get(userA)).toMatchObject({ displayName: "大輝" });
  });

  it("migrates legacy profiles to the default addressing style", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-profile-legacy-"));
    const databasePath = join(directory, "profile.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        display_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy
      .prepare("INSERT INTO profile VALUES (1, '大輝', '2026-08-09T00:00:00.000Z')")
      .run();

    const repository = createProfileRepository(databasePath);

    expect(await repository.get(LOCAL_USER)).toEqual({
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
  });

  it("rejects a stored addressing style outside the profile contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-profile-invalid-"));
    const databasePath = join(directory, "profile.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        display_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        addressing_style TEXT NOT NULL
      )
    `);
    database
      .prepare("INSERT INTO profile VALUES (1, '大輝', '2026-08-09T00:00:00.000Z', 'chan')")
      .run();

    await expect(createProfileRepository(databasePath).get(LOCAL_USER)).rejects.toThrow("Invalid stored profile");
  });

  it("saves a profile, overwrites it, and survives reopening SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-profile-"));
    const databasePath = join(directory, "profile.sqlite");
    const firstNow = () => new Date("2026-08-08T01:00:00.000Z");
    const secondNow = () => new Date("2026-08-08T02:00:00.000Z");
    const repository = createProfileRepository(databasePath, firstNow);

    const firstSaved = await repository.save(userA, { displayName: "大輝", addressingStyle: "san" });
    const saved = await createProfileRepository(databasePath, secondNow).save(userA, {
      displayName: "ユウ",
      addressingStyle: "none",
    });

    expect(firstSaved).toEqual({
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-08T01:00:00.000Z",
    });
    expect(saved).toEqual({
      displayName: "ユウ",
      addressingStyle: "none",
      updatedAt: "2026-08-08T02:00:00.000Z",
    });
    expect(await createProfileRepository(databasePath).get(userA)).toEqual(saved);
  });
});

it("keeps personal details private to their owner after reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zundamon-profile-"));
  const path = join(directory, "profile.sqlite");
  const first = createProfileRepository(path);
  await first.save(userA, {displayName:"テスト",addressingStyle:"san",occupation:"企画",region:"東京"});
  const reopened = createProfileRepository(path);
  expect(await reopened.get(userA)).toMatchObject({occupation:"企画",region:"東京"});
  expect(await reopened.get(userB)).toBeNull();
  await reopened.save(userB, {displayName:"別人",addressingStyle:"san",occupation:"",region:""});
  expect(await reopened.get(userA)).toMatchObject({occupation:"企画",region:"東京"});
});
