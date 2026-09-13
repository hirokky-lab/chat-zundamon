import { describe, expect, it } from "vitest";
import {
  initialSessionState,
  sessionReducer,
} from "../src/session-reducer";

describe("sessionReducer", () => {
  it("moves from connecting to listening and records turns", () => {
    let state = initialSessionState;
    state = sessionReducer(state, { type: "connected" });
    state = sessionReducer(state, {
      type: "transcript",
      turn: { role: "assistant", text: "おかえりなさい" },
    });

    expect(state.phase).toBe("listening");
    expect(state.turns).toEqual([
      { role: "assistant", text: "おかえりなさい" },
    ]);
    expect(state.microphoneEnabled).toBe(true);
  });

  it("tracks speaking and listening without losing the transcript", () => {
    const withTurn = sessionReducer(
      sessionReducer(initialSessionState, { type: "connected" }),
      {
        type: "transcript",
        turn: { role: "user", text: "ただいま" },
      },
    );

    const speaking = sessionReducer(withTurn, { type: "speaking" });
    const listening = sessionReducer(speaking, { type: "listening" });

    expect(speaking.phase).toBe("speaking");
    expect(listening.phase).toBe("listening");
    expect(listening.turns).toEqual([{ role: "user", text: "ただいま" }]);
  });

  it("marks microphone disabled after stop", () => {
    const state = sessionReducer(
      { ...initialSessionState, microphoneEnabled: true },
      { type: "stopped" },
    );

    expect(state.microphoneEnabled).toBe(false);
    expect(state.phase).toBe("ended");
  });

  it("preserves a connection failure for the UI and disables the microphone", () => {
    const error = new Error("permission denied");
    const state = sessionReducer(
      { ...initialSessionState, microphoneEnabled: true },
      { type: "failed", error },
    );

    expect(state).toMatchObject({
      phase: "error",
      microphoneEnabled: false,
      error,
    });
    expect(state.errorKind).toBe("connection");
  });

});
