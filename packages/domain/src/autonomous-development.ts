const TASK_KINDS = [
  "talk_stabilization",
  "prototype_structure",
  "memory_one_toggle",
  "web_search_boundary",
  "one_time_reminder",
  "photo_camera_mvp",
  "calendar_tasks_preparation",
  "pre_public_audit",
] as const;

const ITEM_STATES = ["ready", "verified", "integrated_local", "parked", "blocked"] as const;
const SECRET_LIKE = /(?:sk-|bearer|token|secret|api[_-]?key)/iu;
const SHA_40 = /^[a-f0-9]{40}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export type AutonomousTaskKind = typeof TASK_KINDS[number];
export type AutonomousInventoryState = typeof ITEM_STATES[number];

export type AutonomousContract = Readonly<{
  schemaVersion: "yui-autonomous-contract.v1";
  contractId: string;
  project: "yui";
  canonicalBaseSha: string;
  maxCumulativeCostCents: 600;
  approvedTaskKinds: readonly AutonomousTaskKind[];
}>;

export type AutonomousInventoryItem = Readonly<{
  id: string;
  kind: AutonomousTaskKind;
  acceptanceDigest: string;
  authorityDigest: string;
  dependencyIds: readonly string[];
  state: AutonomousInventoryState;
}>;

export type AutonomousSelectionState = Readonly<{
  canonicalSha: string;
  integratedTaskIds: readonly string[];
}>;

export type SelectedAutonomousTask = AutonomousInventoryItem & Readonly<{ taskFingerprint: string }>;
export type AutonomousCostEntry = Readonly<{ dispatchKey: string; maximumCents: number; status: "reserved" | "settled" | "unknown"; actualCents: number | null }>;
export type AutonomousCostLedger = Readonly<{ settledCents: number; reservedCents: number; unknownCents: number; entries: readonly AutonomousCostEntry[] }>;
export type AutonomousCostState = Readonly<{ cost: AutonomousCostLedger }>;
export type AutonomousRuntimeState = Readonly<{ integratedTaskIds: readonly string[] }>;
export type AutonomousRuntimeEvent = Readonly<{ type: "integrated_local"; taskId: string }>;
export type BridgeEnvelope = Readonly<{ requestId: string; continuationContractId: string; taskId: string; taskFingerprint: string; canonicalSha: string; outcome: "auto_continue" }>;

function validCents(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600; }
function validLedger(value: unknown): value is AutonomousCostLedger {
  if (!isRecord(value) || !validCents(value.settledCents) || !validCents(value.reservedCents) || !validCents(value.unknownCents) || !Array.isArray(value.entries)) return false;
  const entries = value.entries;
  if (!entries.every((entry) => isRecord(entry)
    && safeIdentifier(entry.dispatchKey)
    && validCents(entry.maximumCents)
    && (entry.status === "reserved" || entry.status === "settled" || entry.status === "unknown")
    && (entry.actualCents === null || validCents(entry.actualCents)))) return false;
  const reserved = entries.filter((entry) => entry.status === "reserved").reduce((sum, entry) => sum + (entry.maximumCents as number), 0);
  const settled = entries.filter((entry) => entry.status === "settled").reduce((sum, entry) => sum + (entry.actualCents as number), 0);
  const unknown = entries.filter((entry) => entry.status === "unknown").reduce((sum, entry) => sum + (entry.maximumCents as number), 0);
  return value.reservedCents === reserved && value.settledCents === settled && value.unknownCents === unknown
    && value.settledCents + value.reservedCents + value.unknownCents <= 600;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value) && !SECRET_LIKE.test(value);
}

function isTaskKind(value: unknown): value is AutonomousTaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

function isState(value: unknown): value is AutonomousInventoryState {
  return typeof value === "string" && (ITEM_STATES as readonly string[]).includes(value);
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else codePoint = 0xfffd;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) codePoint = 0xfffd;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return bytes;
}

function sha256Hex(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) words[index] = ((bytes[offset + index * 4]! << 24) | (bytes[offset + index * 4 + 1]! << 16) | (bytes[offset + index * 4 + 2]! << 8) | bytes[offset + index * 4 + 3]!) >>> 0;
    for (let index = 16; index < 64; index += 1) {
      const s0 = ((words[index - 15]! >>> 7) | (words[index - 15]! << 25)) ^ ((words[index - 15]! >>> 18) | (words[index - 15]! << 14)) ^ (words[index - 15]! >>> 3);
      const s1 = ((words[index - 2]! >>> 17) | (words[index - 2]! << 15)) ^ ((words[index - 2]! >>> 19) | (words[index - 2]! << 13)) ^ (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choose + SHA_256_K[index]! + words[index]!) >>> 0;
      const s0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0; hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0; hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function parseAutonomousContract(input: unknown): AutonomousContract {
  if (!isRecord(input)
    || !exactKeys(input, ["schemaVersion", "contractId", "project", "canonicalBaseSha", "maxCumulativeCostCents", "approvedTaskKinds"])
    || input.schemaVersion !== "yui-autonomous-contract.v1"
    || !safeIdentifier(input.contractId)
    || input.project !== "yui"
    || typeof input.canonicalBaseSha !== "string" || !SHA_40.test(input.canonicalBaseSha)
    || input.maxCumulativeCostCents !== 600
    || !Array.isArray(input.approvedTaskKinds)
    || input.approvedTaskKinds.length === 0
    || !input.approvedTaskKinds.every(isTaskKind)
    || new Set(input.approvedTaskKinds).size !== input.approvedTaskKinds.length) {
    throw new Error("autonomous_contract_invalid");
  }
  return {
    schemaVersion: input.schemaVersion,
    contractId: input.contractId,
    project: input.project,
    canonicalBaseSha: input.canonicalBaseSha,
    maxCumulativeCostCents: input.maxCumulativeCostCents,
    approvedTaskKinds: [...input.approvedTaskKinds],
  };
}

export function parseAutonomousInventory(input: unknown): readonly AutonomousInventoryItem[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("autonomous_inventory_invalid");
  const parsed = input.map((value) => {
    if (!isRecord(value)
      || !exactKeys(value, ["id", "kind", "acceptanceDigest", "authorityDigest", "dependencyIds", "state"])
      || !safeIdentifier(value.id)
      || !isTaskKind(value.kind)
      || typeof value.acceptanceDigest !== "string" || !SHA_256.test(value.acceptanceDigest)
      || typeof value.authorityDigest !== "string" || !SHA_256.test(value.authorityDigest)
      || !Array.isArray(value.dependencyIds) || !value.dependencyIds.every(safeIdentifier)
      || new Set(value.dependencyIds).size !== value.dependencyIds.length
      || !isState(value.state)) throw new Error("autonomous_inventory_invalid");
    return { id: value.id, kind: value.kind, acceptanceDigest: value.acceptanceDigest, authorityDigest: value.authorityDigest, dependencyIds: [...value.dependencyIds], state: value.state };
  });
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw new Error("autonomous_inventory_invalid");
  return parsed;
}

export function fingerprintAutonomousTask(contract: AutonomousContract, item: AutonomousInventoryItem): string {
  return sha256Hex(JSON.stringify({ contractId: contract.contractId, canonicalBaseSha: contract.canonicalBaseSha, id: item.id, kind: item.kind, acceptanceDigest: item.acceptanceDigest, authorityDigest: item.authorityDigest, dependencyIds: [...item.dependencyIds].sort() }));
}

export function selectNextAutonomousTask(
  contract: AutonomousContract,
  inventory: readonly AutonomousInventoryItem[],
  state: AutonomousSelectionState,
): SelectedAutonomousTask | null {
  if (!SHA_40.test(state.canonicalSha) || state.canonicalSha !== contract.canonicalBaseSha) return null;
  const known = new Map(inventory.map((item) => [item.id, item]));
  const integrated = new Set(state.integratedTaskIds);
  const priority = (kind: AutonomousTaskKind) => TASK_KINDS.indexOf(kind);
  const candidates = inventory.filter((item) => item.state === "ready"
    && contract.approvedTaskKinds.includes(item.kind)
    && item.dependencyIds.every((id) => known.has(id) && integrated.has(id)));
  const next = [...candidates].sort((left, right) => priority(left.kind) - priority(right.kind) || left.id.localeCompare(right.id))[0];
  return next ? { ...next, taskFingerprint: fingerprintAutonomousTask(contract, next) } : null;
}

export function reduceAutonomousState(state: AutonomousRuntimeState, event: AutonomousRuntimeEvent): AutonomousRuntimeState {
  if (event.type !== "integrated_local" || !safeIdentifier(event.taskId) || state.integratedTaskIds.some((taskId) => taskId === event.taskId)) return state;
  return { integratedTaskIds: [...state.integratedTaskIds, event.taskId] };
}

export function toBridgeEnvelope(input: Readonly<{ requestId: string; taskId: string; taskFingerprint: string; canonicalSha: string }>): BridgeEnvelope | null {
  if (!safeIdentifier(input.requestId) || !safeIdentifier(input.taskId) || !SHA_256.test(input.taskFingerprint) || !SHA_40.test(input.canonicalSha)) return null;
  return { requestId: input.requestId, continuationContractId: input.requestId, taskId: input.taskId, taskFingerprint: input.taskFingerprint, canonicalSha: input.canonicalSha, outcome: "auto_continue" };
}

export function reserveAutonomousCost(state: AutonomousCostState, input: Readonly<{ dispatchKey: string; maximumCents: number }>): Readonly<{ status: "reserved" | "rejected"; state: AutonomousCostState }> {
  const cost = state.cost;
  if (!validLedger(cost) || !safeIdentifier(input.dispatchKey) || !Number.isInteger(input.maximumCents) || input.maximumCents < 1
    || cost.unknownCents > 0 || cost.entries.some((entry) => entry.dispatchKey === input.dispatchKey)
    || cost.settledCents + cost.reservedCents + cost.unknownCents + input.maximumCents > 600) return { status: "rejected", state };
  return { status: "reserved", state: { cost: { ...cost, reservedCents: cost.reservedCents + input.maximumCents, entries: [...cost.entries, { dispatchKey: input.dispatchKey, maximumCents: input.maximumCents, status: "reserved", actualCents: null }] } } };
}

export function settleAutonomousCost(state: AutonomousCostState, input: Readonly<{ dispatchKey: string; actualCents: number }>): AutonomousCostState {
  if (!validLedger(state.cost) || !safeIdentifier(input.dispatchKey) || !validCents(input.actualCents)) return state;
  const entry = state.cost.entries.find((candidate) => candidate.dispatchKey === input.dispatchKey && candidate.status === "reserved");
  if (!entry || input.actualCents > entry.maximumCents) return state;
  return { cost: { ...state.cost, reservedCents: state.cost.reservedCents - entry.maximumCents, settledCents: state.cost.settledCents + input.actualCents, entries: state.cost.entries.map((candidate) => candidate === entry ? { ...candidate, status: "settled", actualCents: input.actualCents } : candidate) } };
}

export function markAutonomousCostUnknown(state: AutonomousCostState, dispatchKey: string): AutonomousCostState {
  if (!validLedger(state.cost) || !safeIdentifier(dispatchKey)) return state;
  const entry = state.cost.entries.find((candidate) => candidate.dispatchKey === dispatchKey && candidate.status === "reserved");
  if (!entry) return state;
  return { cost: { ...state.cost, reservedCents: state.cost.reservedCents - entry.maximumCents, unknownCents: state.cost.unknownCents + entry.maximumCents, entries: state.cost.entries.map((candidate) => candidate === entry ? { ...candidate, status: "unknown" } : candidate) } };
}

export function buildPdcaRecord(input: Readonly<{ taskId: string; outcome: "verified" | "failed"; canonical: "integrated_local" | "not_run"; preview: "not_run"; production: "not_run"; notRun: readonly string[]; notes?: unknown }>): Readonly<{ taskId: string; outcome: "verified" | "failed"; canonical: "integrated_local" | "not_run"; preview: "not_run"; production: "not_run"; notRun: readonly string[] }> {
  if (!safeIdentifier(input.taskId) || !input.notRun.every(safeIdentifier)) throw new Error("autonomous_pdca_invalid");
  return { taskId: input.taskId, outcome: input.outcome, canonical: input.canonical, preview: input.preview, production: input.production, notRun: [...input.notRun] };
}
