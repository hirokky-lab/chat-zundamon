import { parseProfile } from "../../../packages/domain/src/index.js";
import type { Profile } from "../../../packages/domain/src/index.js";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_USER, type RequestUser } from "./request-user.js";

type ProfileInput = Pick<Profile, "displayName" | "addressingStyle" | "occupation" | "region">;

export type ProfileRepository = {
  get(user: RequestUser): Promise<Profile | null>;
  save(user: RequestUser, profile: ProfileInput | string): Promise<Profile>;
};

type ProfileRow = {
  display_name: string;
  addressing_style: string;
  updated_at: string;
  occupation: string | null;
  region: string | null;
};

export function createProfileRepository(
  databasePath: string,
  now: () => Date = () => new Date(),
): ProfileRepository {
  const database = new DatabaseSync(databasePath);
  const existingColumns = database.prepare("PRAGMA table_info(profile)").all() as Array<{ name: string }>;
  if (existingColumns.length > 0 && !existingColumns.some((column) => column.name === "user_id")) {
    const hasAddressingStyle = existingColumns.some((column) => column.name === "addressing_style");
    database.exec(`
      BEGIN;
      CREATE TABLE profile_scoped (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        addressing_style TEXT NOT NULL DEFAULT 'san',
        updated_at TEXT NOT NULL
      );
      INSERT INTO profile_scoped (user_id, display_name, addressing_style, updated_at)
      SELECT '${LOCAL_USER.userId}', display_name, ${hasAddressingStyle ? "addressing_style" : "'san'"}, updated_at
      FROM profile WHERE singleton = 1;
      DROP TABLE profile;
      ALTER TABLE profile_scoped RENAME TO profile;
      COMMIT;
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      addressing_style TEXT NOT NULL DEFAULT 'san',
      updated_at TEXT NOT NULL
    )
  `);

  const columns = database.prepare("PRAGMA table_info(profile)").all() as Array<{ name: string }>;
  for (const column of ["occupation", "region"]) {
    if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE profile ADD COLUMN ${column} TEXT`);
  }
  return {
    async get(user) {
      const row = database
        .prepare(
          "SELECT display_name, addressing_style, updated_at, occupation, region FROM profile WHERE user_id = ?",
        )
        .get(user.userId) as ProfileRow | undefined;
      if (!row) return null;
      const profile = parseProfile({
        displayName: row.display_name,
        addressingStyle: row.addressing_style,
        updatedAt: row.updated_at,
        ...(row.occupation !== null ? { occupation: row.occupation } : {}),
        ...(row.region !== null ? { region: row.region } : {}),
      });
      if (!profile) throw new Error("Invalid stored profile");
      return profile;
    },
    async save(user, input) {
      const { displayName, addressingStyle, occupation, region }: ProfileInput = typeof input === "string"
        ? { displayName: input, addressingStyle: "san" }
        : input;
      const profile = parseProfile({
        displayName,
        addressingStyle,
        updatedAt: now().toISOString(),
        occupation, region,
      });
      if (!profile) throw new Error("Invalid profile");
      database
        .prepare(
          `INSERT INTO profile (user_id, display_name, addressing_style, updated_at, occupation, region)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             display_name = excluded.display_name,
             addressing_style = excluded.addressing_style,
             updated_at = excluded.updated_at,
             occupation = COALESCE(excluded.occupation, profile.occupation),
             region = COALESCE(excluded.region, profile.region)`,
        )
        .run(user.userId, profile.displayName, profile.addressingStyle, profile.updatedAt, profile.occupation ?? null, profile.region ?? null);
      return (await this.get(user))!;
    },
  };
}
