import { describe, expect, it, vi } from "vitest";
import {
  CostLimitError,
  createRpcCostGuard,
  type CostRpcClient,
} from "../src/cost-guard";
import { LOCAL_USER } from "../src/request-user";

const limits = {
  dailyUsd: 3,
  monthlyUsd: 10,
  chatUsd: 0.1,
  memoryUsd: 0.1,
  transcriptionUsd: 0.1,
  realtimeUsd: 1,
  searchUsd: 0.1,
  calendarUsd: 0.1,
  notificationUsd: 0.1,
  imageUsd: 0.1,
  workUsd: 0.1,
  avatarUsd: 0.1,
  storageUsd: 0.1,
};

function client(
  rpc: CostRpcClient["rpc"],
): CostRpcClient {
  return { rpc };
}

describe("cost guard", () => {
  it("delegates an idempotent reservation and settlement to the atomic database RPC", async () => {
    const rpc = vi.fn<CostRpcClient["rpc"]>(async (name) => ({
      data: { request_id: "chat:message-1", state: name === "reserve_yui_cost" ? "reserved" : "settled" },
      error: null,
    }));
    const guard = createRpcCostGuard(client(rpc), limits);

    const reservation = await guard.reserve({
      user: LOCAL_USER,
      requestId: "chat:message-1",
      feature: "chat",
      maximumUsd: 0.1,
    });
    await reservation.settle(0.0125);
    await reservation.settle(0.0125);

    expect(rpc).toHaveBeenNthCalledWith(1, "reserve_yui_cost", {
      p_user_id: LOCAL_USER.userId,
      p_request_id: "chat:message-1",
      p_feature: "chat",
      p_reserved_usd: 0.1,
      p_request_max_usd: 0.1,
      p_daily_max_usd: 3,
      p_monthly_max_usd: 10,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "settle_yui_cost", {
      p_user_id: LOCAL_USER.userId,
      p_request_id: "chat:message-1",
      p_actual_usd: 0.0125,
      p_succeeded: true,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    "request cost limit exceeded",
    "daily cost limit exceeded",
    "monthly cost limit exceeded",
  ])("turns a database limit denial into a neutral typed error: %s", async (message) => {
    const guard = createRpcCostGuard(client(async () => ({
      data: null,
      error: { message },
    })), limits);

    await expect(guard.reserve({
      user: LOCAL_USER,
      requestId: "chat:message-2",
      feature: "chat",
      maximumUsd: 0.1,
    })).rejects.toBeInstanceOf(CostLimitError);
  });

  it("keeps unknown upstream completion in held state", async () => {
    const rpc = vi.fn<CostRpcClient["rpc"]>(async () => ({ data: {}, error: null }));
    const reservation = await createRpcCostGuard(client(rpc), limits).reserve({
      user: LOCAL_USER,
      requestId: "realtime:session-1",
      feature: "realtime",
      maximumUsd: 1,
    });

    await reservation.hold();
    await reservation.hold();

    expect(rpc).toHaveBeenLastCalledWith("settle_yui_cost", {
      p_user_id: LOCAL_USER.userId,
      p_request_id: "realtime:session-1",
      p_actual_usd: 0,
      p_succeeded: false,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("propagates an atomic database denial when parallel reservations reach the ceiling", async () => {
    let accepted = 0;
    const guard = createRpcCostGuard(client(async (name) => {
      if (name !== "reserve_yui_cost") return { data: {}, error: null };
      accepted += 1;
      return accepted === 1
        ? { data: { state: "reserved" }, error: null }
        : { data: null, error: { message: "daily cost limit exceeded" } };
    }), limits);

    const results = await Promise.allSettled([
      guard.reserve({ user: LOCAL_USER, requestId: "chat:parallel-1", feature: "chat", maximumUsd: 0.1 }),
      guard.reserve({ user: LOCAL_USER, requestId: "chat:parallel-2", feature: "chat", maximumUsd: 0.1 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(CostLimitError),
    });
  });

  it("rejects unknown features and a reservation above the configured feature ceiling before RPC", async () => {
    const rpc = vi.fn<CostRpcClient["rpc"]>();
    const guard = createRpcCostGuard(client(rpc), limits);

    await expect(guard.reserve({
      user: LOCAL_USER,
      requestId: "chat:message-3",
      feature: "chat",
      maximumUsd: 0.11,
    })).rejects.toBeInstanceOf(CostLimitError);
    await expect(guard.reserve({
      user: LOCAL_USER,
      requestId: "other:message-3",
      feature: "other" as "chat",
      maximumUsd: 0.1,
    })).rejects.toBeInstanceOf(CostLimitError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reserves external work in its independent cost area", async () => {
    const rpc = vi.fn<CostRpcClient["rpc"]>(async () => ({ data: {}, error: null }));
    const guard = createRpcCostGuard(client(rpc), limits);

    await guard.reserve({
      user: LOCAL_USER,
      requestId: "external:search:sha256:abc:1",
      feature: "search",
      maximumUsd: 0.1,
    });

    expect(rpc).toHaveBeenCalledWith("reserve_yui_cost", expect.objectContaining({
      p_feature: "search",
      p_request_max_usd: 0.1,
    }));
  });
});
