import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markOwnerCostUnknown, reserveOwnerCost, settleOwnerCost } from "./yui-autonomous-cost-ledger.js";

describe("YUI autonomous owner cost ledger", () => {
  it("persists one owner-only reservation and rejects a duplicate dispatch key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-1",
      maximumCents: 10,
    })).resolves.toMatchObject({ status: "reserved" });

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-1",
      maximumCents: 10,
    })).resolves.toMatchObject({ status: "rejected" });

    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      contractId: "YUI-AUTONOMOUS-20260822",
      cost: { reservedCents: 10 },
    });
  });

  it("fails closed when persisted totals do not match their entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");
    await writeFile(statePath, JSON.stringify({
      schemaVersion: "yui-autonomous-cost-ledger.v1",
      contractId: "YUI-AUTONOMOUS-20260822",
      cost: {
        settledCents: 0,
        reservedCents: 0,
        unknownCents: 0,
        entries: [{ dispatchKey: "prior-web", maximumCents: 10, status: "reserved", actualCents: null }],
      },
    }), { mode: 0o600 });

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-2",
      maximumCents: 10,
    })).resolves.toEqual({ status: "unavailable" });
  });

  it("fails closed rather than reusing a ledger that is not owner-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");
    await writeFile(statePath, JSON.stringify({
      schemaVersion: "yui-autonomous-cost-ledger.v1",
      contractId: "YUI-AUTONOMOUS-20260822",
      cost: { settledCents: 0, reservedCents: 0, unknownCents: 0, entries: [] },
    }), { mode: 0o600 });
    await chmod(statePath, 0o644);

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-3",
      maximumCents: 10,
    })).resolves.toEqual({ status: "unavailable" });
  });

  it("fails closed when the owner ledger parent directory is not owner-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");
    await chmod(directory, 0o755);

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-parent-mode",
      maximumCents: 10,
    })).resolves.toEqual({ status: "unavailable" });
  });

  it("locks later paid dispatches after an unverified result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");
    await reserveOwnerCost({ statePath, contractId: "YUI-AUTONOMOUS-20260822", dispatchKey: "web-search-evaluation-4", maximumCents: 10 });

    await expect(markOwnerCostUnknown({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-4",
    })).resolves.toMatchObject({ status: "unknown" });

    await expect(reserveOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-5",
      maximumCents: 10,
    })).resolves.toEqual({ status: "rejected" });
  });

  it("settles a known actual cost once and releases the unused reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-cost-ledger-"));
    const statePath = join(directory, "cost.json");
    await reserveOwnerCost({ statePath, contractId: "YUI-AUTONOMOUS-20260822", dispatchKey: "web-search-evaluation-6", maximumCents: 10 });

    await expect(settleOwnerCost({
      statePath,
      contractId: "YUI-AUTONOMOUS-20260822",
      dispatchKey: "web-search-evaluation-6",
      actualCents: 2,
    })).resolves.toMatchObject({ status: "settled", state: { cost: { settledCents: 2, reservedCents: 0 } } });
  });
});
