export type TalkCausalCue =
  | { phase: "received"; requestId: string }
  | { phase: "waiting"; requestId: string }
  | { phase: "delivered"; requestId: string; replyGroupId: string };

export type TalkCausalCueState = {
  generation: number;
  activeRequestId: string | null;
  terminalRequestIds: readonly string[];
  cue: TalkCausalCue | null;
};

export type TalkCausalCueObservation =
  | { type: "received"; requestId: string }
  | { type: "retry"; requestId: string }
  | { type: "waiting"; requestId: string }
  | { type: "failed"; requestId: string }
  | { type: "delivered"; requestId: string; replyGroupId: string };

type TalkCausalCueEvent =
  | { type: "reset"; generation: number }
  | { type: "clear"; generation: number }
  | { type: "dismiss-delivered"; generation: number; requestId: string }
  | (TalkCausalCueObservation & { generation: number });

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);

const parseEvent = (value: unknown): TalkCausalCueEvent | null => {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (!isGeneration(event.generation)) return null;
  if (event.type === "reset") return { type: "reset", generation: event.generation };
  if (event.type === "clear") return { type: "clear", generation: event.generation };
  if (!isSafeId(event.requestId)) return null;

  if (event.type === "received" || event.type === "retry" || event.type === "waiting" || event.type === "failed" || event.type === "dismiss-delivered") {
    return { type: event.type, generation: event.generation, requestId: event.requestId };
  }
  if (event.type === "delivered" && isSafeId(event.replyGroupId)) {
    return { type: "delivered", generation: event.generation, requestId: event.requestId, replyGroupId: event.replyGroupId };
  }
  return null;
};

const rememberTerminal = (state: TalkCausalCueState, requestId: string): readonly string[] => {
  if (state.terminalRequestIds.includes(requestId)) return state.terminalRequestIds;
  return [...state.terminalRequestIds, requestId];
};

export const initialTalkCausalCueState = (generation: number): TalkCausalCueState => ({
  generation,
  activeRequestId: null,
  terminalRequestIds: [],
  cue: null,
});

export const reduceTalkCausalCue = (state: TalkCausalCueState, input: unknown): TalkCausalCueState => {
  const event = parseEvent(input);
  if (!event || event.generation < state.generation) return state;
  if (event.type === "reset") {
    return event.generation === state.generation ? state : initialTalkCausalCueState(event.generation);
  }

  const current = event.generation === state.generation ? state : initialTalkCausalCueState(event.generation);

  if (event.type === "clear") {
    return current.activeRequestId === null && current.terminalRequestIds.length === 0 && current.cue === null
      ? current
      : initialTalkCausalCueState(current.generation);
  }

  if (event.type === "dismiss-delivered") {
    return current.cue?.phase === "delivered" && current.cue.requestId === event.requestId
      ? { ...current, cue: null }
      : current;
  }

  if (event.type === "retry") {
    if (current.activeRequestId || !current.terminalRequestIds.includes(event.requestId)) return current;
    return {
      ...current,
      activeRequestId: event.requestId,
      terminalRequestIds: current.terminalRequestIds.filter((requestId) => requestId !== event.requestId),
      cue: { phase: "received", requestId: event.requestId },
    };
  }

  if (current.terminalRequestIds.includes(event.requestId)) return current;

  if (event.type === "received") {
    if (current.activeRequestId && current.activeRequestId !== event.requestId) return current;
    if (current.activeRequestId === event.requestId) return current;
    return { ...current, activeRequestId: event.requestId, cue: { phase: "received", requestId: event.requestId } };
  }

  if (current.activeRequestId !== event.requestId) return current;
  if (event.type === "waiting") {
    if (current.cue?.phase === "waiting") return current;
    return { ...current, cue: { phase: "waiting", requestId: event.requestId } };
  }
  if (event.type === "failed") {
    return {
      ...current,
      activeRequestId: null,
      terminalRequestIds: rememberTerminal(current, event.requestId),
      cue: null,
    };
  }
  return {
    ...current,
    activeRequestId: null,
    terminalRequestIds: rememberTerminal(current, event.requestId),
    cue: { phase: "delivered", requestId: event.requestId, replyGroupId: event.replyGroupId },
  };
};
