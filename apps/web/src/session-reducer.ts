import type { TranscriptTurn } from "@yui/domain";

export type SessionPhase =
  | "connecting"
  | "listening"
  | "speaking"
  | "ended"
  | "error";

export type SessionState = {
  phase: SessionPhase;
  microphoneEnabled: boolean;
  turns: TranscriptTurn[];
  error: Error | null;
  errorKind: "connection" | null;
};

export type SessionAction =
  | { type: "reset" }
  | { type: "connected" }
  | { type: "listening" }
  | { type: "speaking" }
  | { type: "microphone"; enabled: boolean }
  | { type: "transcript"; turn: TranscriptTurn; id?: string; occurredAt?: string }
  | { type: "stopped" }
  | { type: "failed"; error: Error };

export const initialSessionState: SessionState = {
  phase: "connecting",
  microphoneEnabled: false,
  turns: [],
  error: null,
  errorKind: null,
};

export function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "reset":
      return initialSessionState;
    case "connected":
      return {
        ...state,
        phase: "listening",
        microphoneEnabled: true,
        error: null,
        errorKind: null,
      };
    case "listening":
      return { ...state, phase: "listening" };
    case "speaking":
      return { ...state, phase: "speaking" };
    case "microphone":
      return { ...state, microphoneEnabled: action.enabled };
    case "transcript":
      return { ...state, turns: [...state.turns, action.turn] };
    case "stopped":
      return { ...state, phase: "ended", microphoneEnabled: false };
    case "failed":
      return {
        ...state,
        phase: "error",
        microphoneEnabled: false,
        error: action.error,
        errorKind: "connection",
      };
  }
}
