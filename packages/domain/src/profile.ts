export type AddressingStyle = "san" | "none";

export interface Profile {
  displayName: string;
  addressingStyle: AddressingStyle;
  updatedAt: string;
  occupation?: string;
  region?: string;
}

const controlOrNewline = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const wrappers = [/^(.+?)です$/u, /^(.+?)と呼んで(?:ください)?$/u];

export function parseDisplayName(input: string): string | null {
  if (controlOrNewline.test(input)) return null;
  const trimmed = input.trim().normalize("NFKC");
  if (!trimmed) return null;
  const wrapped = wrappers.find((pattern) => pattern.test(trimmed));
  const candidate = (wrapped?.exec(trimmed)?.[1] ?? trimmed).trim();
  if (candidate.length < 1 || candidate.length > 20) return null;
  if (/[、。！？!?]|(?:だけど|ですが|または|あるいは)/u.test(candidate)) return null;
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseProfile(value: unknown): Profile | null {
  if (!isRecord(value)) return null;

  const displayName = typeof value.displayName === "string"
    ? parseDisplayName(value.displayName)
    : null;
  if (
    !displayName ||
    (value.addressingStyle !== "san" && value.addressingStyle !== "none") ||
    !isCanonicalIsoTimestamp(value.updatedAt)
  ) {
    return null;
  }

  const details: { occupation?: string; region?: string } = {};
  for (const key of ["occupation", "region"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].length > 120 || controlOrNewline.test(value[key])) return null;
    details[key] = value[key].trim();
  }
  return { displayName, addressingStyle: value.addressingStyle, updatedAt: value.updatedAt, ...details };
}

export function formatAddressedName(
  profile: Pick<Profile, "displayName" | "addressingStyle">,
): string {
  if (profile.addressingStyle === "none" || profile.displayName.endsWith("さん")) {
    return profile.displayName;
  }
  return `${profile.displayName}さん`;
}
