import type { RealtimeClient } from "./realtime-client";

export const CALL_START_TIMEOUT_MS = 12_000;

export type CallStartOutcome = "connected" | "failed";

export type CallStartAttempt = {
  generation: number;
  client: RealtimeClient;
  timeoutId: number;
  finished: boolean;
};

function stopClient(client: RealtimeClient): void {
  try {
    const result = client.stop();
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
  } catch {
    // Cleanup failures must not leave the app in its preparing state.
  }
}

export function createCallStartAttempt(
  generation: number,
  client: RealtimeClient,
  onTimeout: (generation: number) => void,
): CallStartAttempt {
  const attempt: CallStartAttempt = {
    generation,
    client,
    timeoutId: 0,
    finished: false,
  };
  attempt.timeoutId = window.setTimeout(() => {
    finishCallStart(attempt, "failed");
    onTimeout(generation);
  }, CALL_START_TIMEOUT_MS);
  return attempt;
}

export function finishCallStart(
  attempt: CallStartAttempt,
  outcome: CallStartOutcome = "failed",
): void {
  if (attempt.finished) return;
  attempt.finished = true;
  window.clearTimeout(attempt.timeoutId);
  if (outcome !== "connected") stopClient(attempt.client);
}
