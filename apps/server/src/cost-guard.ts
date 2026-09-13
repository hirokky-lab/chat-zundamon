import { createClient } from "@supabase/supabase-js";
import type { CostLimits } from "./config.js";
import type { RequestUser } from "./request-user.js";

export type CostFeature =
  | "chat"
  | "memory"
  | "transcription"
  | "realtime"
  | "search"
  | "calendar"
  | "notification"
  | "image"
  | "work"
  | "avatar"
  | "storage";

export type CostReservation = {
  requestId: string;
  settle(actualUsd: number): Promise<void>;
  hold(): Promise<void>;
};

export type CostGuard = {
  reserve(input: {
    user: RequestUser;
    requestId: string;
    feature: CostFeature;
    maximumUsd: number;
  }): Promise<CostReservation>;
};

type RpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export type CostRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
};

export class CostLimitError extends Error {
  constructor() {
    super("usage_limit_reached");
  }
}

export class CostGuardUnavailableError extends Error {
  constructor() {
    super("cost_guard_unavailable");
  }
}

const featureCeilingKey: Record<CostFeature, keyof CostLimits> = {
  chat: "chatUsd",
  memory: "memoryUsd",
  transcription: "transcriptionUsd",
  realtime: "realtimeUsd",
  search: "searchUsd",
  calendar: "calendarUsd",
  notification: "notificationUsd",
  image: "imageUsd",
  work: "workUsd",
  avatar: "avatarUsd",
  storage: "storageUsd",
};

export function createRpcCostGuard(
  client: CostRpcClient,
  limits: CostLimits,
): CostGuard {
  return {
    async reserve(input) {
      const ceilingKey = featureCeilingKey[input.feature];
      if (
        !ceilingKey ||
        !Number.isFinite(input.maximumUsd) ||
        input.maximumUsd <= 0 ||
        input.maximumUsd > limits[ceilingKey]
      ) {
        throw new CostLimitError();
      }
      const result = await client.rpc("reserve_yui_cost", {
        p_user_id: input.user.userId,
        p_request_id: input.requestId,
        p_feature: input.feature,
        p_reserved_usd: input.maximumUsd,
        p_request_max_usd: limits[ceilingKey],
        p_daily_max_usd: limits.dailyUsd,
        p_monthly_max_usd: limits.monthlyUsd,
      });
      if (result.error) throw classifyRpcError(result.error);

      let finished = false;
      const finish = async (actualUsd: number, succeeded: boolean): Promise<void> => {
        if (finished) return;
        const settled = await client.rpc("settle_yui_cost", {
          p_user_id: input.user.userId,
          p_request_id: input.requestId,
          p_actual_usd: actualUsd,
          p_succeeded: succeeded,
        });
        if (settled.error) throw classifyRpcError(settled.error);
        finished = true;
      };
      return {
        requestId: input.requestId,
        settle: (actualUsd) => finish(actualUsd, true),
        hold: () => finish(0, false),
      };
    },
  };
}

export function createSupabaseCostGuard(options: {
  url: string;
  serviceRoleKey: string;
  limits: CostLimits;
}): CostGuard {
  const client = createClient(options.url, options.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createRpcCostGuard(client as unknown as CostRpcClient, options.limits);
}

export function createUnlimitedCostGuard(): CostGuard {
  return {
    reserve: async ({ requestId }) => ({
      requestId,
      settle: async () => undefined,
      hold: async () => undefined,
    }),
  };
}

function classifyRpcError(error: { message?: string }): Error {
  if (/^(request|daily|monthly) cost limit exceeded$/.test(error.message ?? "")) {
    return new CostLimitError();
  }
  return new CostGuardUnavailableError();
}
