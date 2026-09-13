import { describe, expect, it } from "vitest";
import { formatAddressedName, parseDisplayName, parseProfile } from "../src/profile";

describe("parseDisplayName", () => {
  it.each([
    ["大輝", "大輝"],
    [" 大輝です ", "大輝"],
    ["大輝と呼んで", "大輝"],
  ])("extracts one safe display name from %s", (input, expected) => {
    expect(parseDisplayName(input)).toBe(expected);
  });

  it.each([
    "",
    "\n",
    "大輝\nです",
    "\n大輝\n",
    "\t大輝",
    "大輝\t",
    "\uFEFF大輝",
    "大\u2028輝",
    "大\u2029輝",
    "名前は大輝だけど普段はダイキ",
  ])(
    "rejects an absent or ambiguous name: %s",
    (input) => expect(parseDisplayName(input)).toBeNull(),
  );
});

describe("profile contracts", () => {
  it("normalizes and validates persisted profiles", () => {
    expect(parseProfile({
      displayName: " 大輝 ",
      addressingStyle: "san",
      updatedAt: "2026-08-09T00:00:00.000Z",
    })).toEqual({
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
  });

  it.each([
    [{ displayName: "大輝", addressingStyle: "san" }, "大輝さん"],
    [{ displayName: "大輝さん", addressingStyle: "san" }, "大輝さん"],
    [{ displayName: "大輝", addressingStyle: "none" }, "大輝"],
  ] as const)("formats the selected form of address", (profile, expected) => {
    expect(formatAddressedName(profile)).toBe(expected);
  });

  it.each([
    null,
    { displayName: "大輝", addressingStyle: "honorific", updatedAt: "2026-08-09T00:00:00.000Z" },
    { displayName: "大輝", addressingStyle: "san", updatedAt: "2026-02-30T00:00:00.000Z" },
  ])("rejects malformed persisted profile data", (value) => {
    expect(parseProfile(value)).toBeNull();
  });
});
