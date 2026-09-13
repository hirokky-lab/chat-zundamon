import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  markAutonomousCostUnknown as markUnknown,
  reserveAutonomousCost,
  settleAutonomousCost,
  type AutonomousCostState,
} from "../packages/domain/src/autonomous-development.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET = /(?:sk-|bearer|token|secret|api[_-]?key)/iu;

type OwnerLedger = Readonly<{
  schemaVersion: "yui-autonomous-cost-ledger.v1";
  contractId: string;
  cost: AutonomousCostState["cost"];
}>;

export type OwnerCostReservation = Readonly<{
  statePath: string;
  contractId: string;
  dispatchKey: string;
  maximumCents: number;
}>;

export type OwnerCostReservationResult =
  | Readonly<{ status: "reserved"; state: OwnerLedger }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "unavailable" }>;

export type OwnerCostUnknown = Readonly<{
  statePath: string;
  contractId: string;
  dispatchKey: string;
}>;

export type OwnerCostUnknownResult =
  | Readonly<{ status: "unknown"; state: OwnerLedger }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "unavailable" }>;

export type OwnerCostSettlement = Readonly<{
  statePath: string;
  contractId: string;
  dispatchKey: string;
  actualCents: number;
}>;

export type OwnerCostSettlementResult =
  | Readonly<{ status: "settled"; state: OwnerLedger }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "unavailable" }>;

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && !SECRET.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyLedger(contractId: string): OwnerLedger {
  return {
    schemaVersion: "yui-autonomous-cost-ledger.v1",
    contractId,
    cost: { settledCents: 0, reservedCents: 0, unknownCents: 0, entries: [] },
  };
}

function validCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600;
}

function validCost(value: unknown): value is AutonomousCostState["cost"] {
  if (!isRecord(value) || !validCents(value.settledCents) || !validCents(value.reservedCents) || !validCents(value.unknownCents) || !Array.isArray(value.entries)) return false;
  if (!value.entries.every((entry) => isRecord(entry)
    && Object.keys(entry).sort().join("|") === "actualCents|dispatchKey|maximumCents|status"
    && safeIdentifier(entry.dispatchKey)
    && validCents(entry.maximumCents)
    && (entry.status === "reserved" || entry.status === "settled" || entry.status === "unknown")
    && (entry.actualCents === null || validCents(entry.actualCents)))) return false;
  const entries = value.entries as Array<Record<string, unknown>>;
  const reserved = entries.filter((entry) => entry.status === "reserved").reduce((sum, entry) => sum + (entry.maximumCents as number), 0);
  const settled = entries.filter((entry) => entry.status === "settled").reduce((sum, entry) => sum + (entry.actualCents as number), 0);
  const unknown = entries.filter((entry) => entry.status === "unknown").reduce((sum, entry) => sum + (entry.maximumCents as number), 0);
  return value.reservedCents === reserved && value.settledCents === settled && value.unknownCents === unknown
    && settled + reserved + unknown <= 600;
}

function readLedger(value: unknown, contractId: string): OwnerLedger | null {
  if (!isRecord(value) || value.schemaVersion !== "yui-autonomous-cost-ledger.v1" || value.contractId !== contractId || !validCost(value.cost)) return null;
  return { schemaVersion: "yui-autonomous-cost-ledger.v1", contractId, cost: value.cost };
}

async function loadLedger(statePath: string, contractId: string): Promise<OwnerLedger | null> {
  try {
    if (((await stat(statePath)).mode & 0o777) !== 0o600) return null;
    return readLedger(JSON.parse(await readFile(statePath, "utf8")), contractId);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyLedger(contractId);
    return null;
  }
}

async function hasOwnerOnlyParent(statePath: string): Promise<boolean> {
  try {
    return ((await stat(dirname(statePath))).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

async function saveLedger(statePath: string, state: OwnerLedger): Promise<boolean> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
    return true;
  } catch {
    await unlink(temporary).catch(() => undefined);
    return false;
  }
}

export async function reserveOwnerCost(input: OwnerCostReservation): Promise<OwnerCostReservationResult> {
  if (!safeIdentifier(input.contractId) || !safeIdentifier(input.dispatchKey) || !Number.isInteger(input.maximumCents) || input.maximumCents < 1 || input.maximumCents > 600) return { status: "rejected" };
  if (!await hasOwnerOnlyParent(input.statePath)) return { status: "unavailable" };
  const lockPath = `${input.statePath}.lock`;
  try {
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    return { status: "unavailable" };
  }
  try {
    const current = await loadLedger(input.statePath, input.contractId);
    if (!current) return { status: "unavailable" };
    const reserved = reserveAutonomousCost({ cost: current.cost }, input);
    if (reserved.status !== "reserved") return { status: "rejected" };
    const next: OwnerLedger = { ...current, cost: reserved.state.cost };
    return await saveLedger(input.statePath, next) ? { status: "reserved", state: next } : { status: "unavailable" };
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function markOwnerCostUnknown(input: OwnerCostUnknown): Promise<OwnerCostUnknownResult> {
  if (!safeIdentifier(input.contractId) || !safeIdentifier(input.dispatchKey)) return { status: "rejected" };
  if (!await hasOwnerOnlyParent(input.statePath)) return { status: "unavailable" };
  const lockPath = `${input.statePath}.lock`;
  try {
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    return { status: "unavailable" };
  }
  try {
    const current = await loadLedger(input.statePath, input.contractId);
    if (!current) return { status: "unavailable" };
    const cost = markUnknown({ cost: current.cost }, input.dispatchKey).cost;
    if (cost === current.cost) return { status: "rejected" };
    const next: OwnerLedger = { ...current, cost };
    return await saveLedger(input.statePath, next) ? { status: "unknown", state: next } : { status: "unavailable" };
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function settleOwnerCost(input: OwnerCostSettlement): Promise<OwnerCostSettlementResult> {
  if (!safeIdentifier(input.contractId) || !safeIdentifier(input.dispatchKey) || !validCents(input.actualCents)) return { status: "rejected" };
  if (!await hasOwnerOnlyParent(input.statePath)) return { status: "unavailable" };
  const lockPath = `${input.statePath}.lock`;
  try {
    await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    return { status: "unavailable" };
  }
  try {
    const current = await loadLedger(input.statePath, input.contractId);
    if (!current) return { status: "unavailable" };
    const cost = settleAutonomousCost({ cost: current.cost }, input).cost;
    if (cost === current.cost) return { status: "rejected" };
    const next: OwnerLedger = { ...current, cost };
    return await saveLedger(input.statePath, next) ? { status: "settled", state: next } : { status: "unavailable" };
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}
