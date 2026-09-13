import { createClient } from "@supabase/supabase-js";
import type { SupabaseAuthClient } from "./auth.js";
import type { UserClientFactory } from "./hosted-repositories.js";

const memoryOperations = new Set([
  "replace_memory", "release_memory_tombstone", "forget_memory", "patch_memory_settings", "apply_memory_action_once",
  "claim_memory_processing", "claim_automatic_memory_processing", "get_automatic_memory_outbox", "save_automatic_memory_outbox",
  "mark_automatic_memory_usage_settled", "clear_automatic_memory_outbox", "apply_automatic_memory_action_once",
  "finish_automatic_memory_processing", "get_latest_automatic_memory_attempt", "prepare_automatic_memory_attempt",
  "set_automatic_memory_attempt_state", "fail_voice_automatic_memory_processing", "has_active_voice_memory_processing",
  "claim_voice_memory_processing", "save_voice_memory_outbox", "mark_voice_memory_usage_settled", "apply_voice_memory_action_once",
  "finish_voice_memory_processing", "cleanup_stale_voice_memory_processing",
]);

export function isAllowedMemoryMutationOperation(name: string): boolean { return memoryOperations.has(name); }

export function createSupabaseAuthClient(url: string, publishableKey: string): SupabaseAuthClient {
  const client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  const auth = client.auth as unknown as SupabaseAuthClient["auth"];
  return {
    auth: {
      getUser: (accessToken) => auth.getUser(accessToken),
    },
  };
}

export function createSupabaseUserClientFactory(url: string, publishableKey: string): UserClientFactory {
  return (user) => createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${user.accessToken}` } },
  }) as unknown as ReturnType<UserClientFactory>;
}

export function createSupabaseServiceMutationClientFactory(url: string, serviceRoleKey: string): UserClientFactory {
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const chatPhotoOperations = new Set([
    "save_chat_snapshot_reconciled", "commit_photo_exchange", "delete_photo_message", "delete_whole_chat_v2",
    "get_google_calendar_tasks_status", "save_google_calendar_tasks_control", "clear_google_calendar_tasks_service",
    "set_google_calendar_tasks_home_visible",
    "create_google_calendar_tasks_oauth_attempt", "consume_google_calendar_tasks_oauth_attempt",
    "save_google_calendar_tasks_oauth_connection", "get_google_calendar_tasks_oauth_connection",
    "clear_google_calendar_tasks_oauth_connection",
    "acquire_google_calendar_tasks_quota", "commit_google_calendar_tasks_quota",
    "release_google_calendar_tasks_quota",
    "put_google_assistant_operation", "get_google_assistant_operation", "transition_google_assistant_operation",
    "create_google_assistant_oauth_attempt",
    "save_google_assistant_oauth_connection",
  ]);
  return (user) => ({
    from: (table: string) => client.from(table) as unknown as ReturnType<ReturnType<UserClientFactory>["from"]>,
    rpc: (name: string, args: Record<string, unknown>) => {
      if (isAllowedMemoryMutationOperation(name)) return client.rpc("server_memory_rpc", {
        p_owner_id: user.userId, p_operation: name, p_args: args,
      }) as unknown as ReturnType<ReturnType<UserClientFactory>["rpc"]>;
      if (chatPhotoOperations.has(name)) return client.rpc(name, {
        p_owner_id: user.userId, ...args,
      }) as unknown as ReturnType<ReturnType<UserClientFactory>["rpc"]>;
      throw new Error("unsupported_service_mutation_operation");
    },
  });
}

/** A narrow service-role client for the already allowlisted photo repository RPCs. */
export function createSupabasePhotoServiceClient(url: string, serviceRoleKey: string) {
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return {
    rpc: async (name: string, args: Record<string, unknown>) => await client.rpc(name, args),
  };
}
