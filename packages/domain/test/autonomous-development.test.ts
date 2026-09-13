import { describe, expect, it } from "vitest";
import {
  buildPdcaRecord,
  fingerprintAutonomousTask,
  markAutonomousCostUnknown,
  parseAutonomousContract,
  parseAutonomousInventory,
  reserveAutonomousCost,
  reduceAutonomousState,
  selectNextAutonomousTask,
  settleAutonomousCost,
  toBridgeEnvelope,
} from "../src/autonomous-development";

const contract = {
  schemaVersion: "yui-autonomous-contract.v1",
  contractId: "YUI-AUTONOMOUS-20260822",
  project: "yui",
  canonicalBaseSha: "43683007892ffc9d81bebb0792fee3acf9907c57",
  maxCumulativeCostCents: 600,
  approvedTaskKinds: ["talk_stabilization", "memory_one_toggle", "web_search_boundary"],
};

const inventory = [{
  id: "talk-safe-failures",
  kind: "talk_stabilization",
  acceptanceDigest: "a".repeat(64),
  authorityDigest: "b".repeat(64),
  dependencyIds: [],
  state: "ready",
}, {
  id: "memory-toggle",
  kind: "memory_one_toggle",
  acceptanceDigest: "c".repeat(64),
  authorityDigest: "d".repeat(64),
  dependencyIds: ["talk-safe-failures"],
  state: "ready",
}];

describe("YUI autonomous development contract", () => {
  it("selects Talk before every other ready approved task and returns a stable fingerprint", () => {
    const selected = selectNextAutonomousTask(
      parseAutonomousContract(contract),
      parseAutonomousInventory(inventory),
      { canonicalSha: contract.canonicalBaseSha, integratedTaskIds: [] },
    );

    expect(selected).toMatchObject({ id: "talk-safe-failures", kind: "talk_stabilization" });
    expect(selected?.taskFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected?.taskFingerprint).toBe("b13d863caed138dd5ffe28a718c401274e1c09dce6bbad9414d1ceda8750718e");
    expect(selected?.taskFingerprint).toBe(fingerprintAutonomousTask(parseAutonomousContract(contract), parseAutonomousInventory(inventory)[0]!));
  });

  it("fails closed for unknown kind, duplicate ID, secret-like text, stale SHA, unapproved work, and unmet dependencies", () => {
    expect(() => parseAutonomousInventory([{ ...inventory[0], kind: "unknown" }])).toThrow("autonomous_inventory_invalid");
    expect(() => parseAutonomousInventory([inventory[0], inventory[0]])).toThrow("autonomous_inventory_invalid");
    expect(() => parseAutonomousInventory([{ ...inventory[0], id: "sk-private-token" }])).toThrow("autonomous_inventory_invalid");
    expect(selectNextAutonomousTask(parseAutonomousContract(contract), parseAutonomousInventory(inventory), {
      canonicalSha: "0".repeat(40), integratedTaskIds: [],
    })).toBeNull();
    expect(selectNextAutonomousTask(parseAutonomousContract({ ...contract, approvedTaskKinds: ["memory_one_toggle"] }), parseAutonomousInventory(inventory), {
      canonicalSha: contract.canonicalBaseSha, integratedTaskIds: [],
    })).toBeNull();
    expect(selectNextAutonomousTask(parseAutonomousContract({ ...contract, approvedTaskKinds: ["memory_one_toggle"] }), parseAutonomousInventory([inventory[1]!]), {
      canonicalSha: contract.canonicalBaseSha, integratedTaskIds: [],
    })).toBeNull();
  });
});

describe("YUI autonomous cost ledger", () => {
  const state = {
    cost: { settledCents: 599, reservedCents: 0, unknownCents: 0, entries: [{ dispatchKey: "prior-web", maximumCents: 599, status: "settled" as const, actualCents: 599 }] },
  };

  it("reserves only within the cumulative 600-cent ceiling and rejects duplicate dispatch", () => {
    const reserved = reserveAutonomousCost(state, { dispatchKey: "web-1", maximumCents: 1 });
    expect(reserved.status).toBe("reserved");
    expect(reserveAutonomousCost(state, { dispatchKey: "web-2", maximumCents: 2 }).status).toBe("rejected");
    expect(reserveAutonomousCost(reserved.state, { dispatchKey: "web-1", maximumCents: 1 }).status).toBe("rejected");
    expect(settleAutonomousCost(reserved.state, { dispatchKey: "web-1", actualCents: 1 }).cost).toMatchObject({ settledCents: 600, reservedCents: 0 });
  });

  it("locks future paid dispatch after an unknown result and redacts unsafe PDCA input", () => {
    const reserved = reserveAutonomousCost({ cost: { settledCents: 0, reservedCents: 0, unknownCents: 0, entries: [] } }, { dispatchKey: "web-1", maximumCents: 5 });
    const locked = markAutonomousCostUnknown(reserved.state, "web-1");
    expect(locked.cost).toMatchObject({ reservedCents: 0, unknownCents: 5 });
    expect(reserveAutonomousCost(locked, { dispatchKey: "web-2", maximumCents: 1 }).status).toBe("rejected");
    expect(buildPdcaRecord({ taskId: "talk-safe-failures", outcome: "verified", canonical: "integrated_local", preview: "not_run", production: "not_run", notRun: ["physical_device"], notes: "Bearer private message" })).toEqual({ taskId: "talk-safe-failures", outcome: "verified", canonical: "integrated_local", preview: "not_run", production: "not_run", notRun: ["physical_device"] });
  });

  it("fails closed when a supplied ledger does not match its entries", () => {
    const malformed = {
      cost: {
        settledCents: 0,
        reservedCents: 0,
        unknownCents: 0,
        entries: [{ dispatchKey: "web-1", maximumCents: 1, status: "reserved", actualCents: null }],
      },
    } as unknown as typeof state;

    expect(reserveAutonomousCost(malformed, { dispatchKey: "web-2", maximumCents: 1 })).toEqual({ status: "rejected", state: malformed });
  });
});

describe("YUI autonomous state transitions", () => {
  it("records one integrated task once and rejects a duplicate or unknown transition", () => {
    const initial = { integratedTaskIds: [] as readonly string[] };
    const integrated = reduceAutonomousState(initial, { type: "integrated_local", taskId: "talk-safe-failures" });

    expect(integrated).toEqual({ integratedTaskIds: ["talk-safe-failures"] });
    expect(reduceAutonomousState(integrated, { type: "integrated_local", taskId: "talk-safe-failures" })).toBe(integrated);
    expect(reduceAutonomousState(integrated, { type: "unknown", taskId: "memory-toggle" } as never)).toBe(integrated);
  });
});

describe("YUI autonomous bridge envelope", () => {
  it("creates a bridge-safe envelope without report prose or an external destination", () => {
    expect(toBridgeEnvelope({ requestId: "YUI-AUTONOMOUS-20260822", taskId: "talk-safe-failures", taskFingerprint: "a".repeat(64), canonicalSha: "b".repeat(40) })).toEqual({
      requestId: "YUI-AUTONOMOUS-20260822",
      continuationContractId: "YUI-AUTONOMOUS-20260822",
      taskId: "talk-safe-failures",
      taskFingerprint: "a".repeat(64),
      canonicalSha: "b".repeat(40),
      outcome: "auto_continue",
    });
  });
});
