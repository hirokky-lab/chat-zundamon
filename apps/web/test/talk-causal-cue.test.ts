import { describe, expect, it } from "vitest";
import { initialTalkCausalCueState, reduceTalkCausalCue } from "../src/talk-causal-cue";

describe("Talk causal display cue", () => {
  it("shows only the observed received, waiting, delivered, and dismissed sequence", () => {
    const received = reduceTalkCausalCue(initialTalkCausalCueState(4), { type: "received", generation: 4, requestId: "message-1" });
    const waiting = reduceTalkCausalCue(received, { type: "waiting", generation: 4, requestId: "message-1" });
    const delivered = reduceTalkCausalCue(waiting, { type: "delivered", generation: 4, requestId: "message-1", replyGroupId: "reply-1" });
    const dismissed = reduceTalkCausalCue(delivered, { type: "dismiss-delivered", generation: 4, requestId: "message-1" });

    expect(received.cue).toEqual({ phase: "received", requestId: "message-1" });
    expect(waiting.cue).toEqual({ phase: "waiting", requestId: "message-1" });
    expect(delivered.cue).toEqual({ phase: "delivered", requestId: "message-1", replyGroupId: "reply-1" });
    expect(dismissed.cue).toBeNull();
  });

  it("does not invent waiting or delivery when events arrive before receipt or for another request", () => {
    const initial = initialTalkCausalCueState(2);
    expect(reduceTalkCausalCue(initial, { type: "waiting", generation: 2, requestId: "message-1" })).toEqual(initial);
    expect(reduceTalkCausalCue(initial, { type: "delivered", generation: 2, requestId: "message-1", replyGroupId: "reply-1" })).toEqual(initial);

    const received = reduceTalkCausalCue(initial, { type: "received", generation: 2, requestId: "message-1" });
    expect(reduceTalkCausalCue(received, { type: "waiting", generation: 2, requestId: "message-other" })).toEqual(received);
  });

  it("clears a failed request and never re-displays its late success", () => {
    const received = reduceTalkCausalCue(initialTalkCausalCueState(3), { type: "received", generation: 3, requestId: "message-1" });
    const failed = reduceTalkCausalCue(received, { type: "failed", generation: 3, requestId: "message-1" });
    const late = reduceTalkCausalCue(failed, { type: "delivered", generation: 3, requestId: "message-1", replyGroupId: "late-reply" });

    expect(failed.cue).toBeNull();
    expect(failed.activeRequestId).toBeNull();
    expect(late).toEqual(failed);
  });

  it("starts a new observed lifecycle when the user retries a failed request", () => {
    const received = reduceTalkCausalCue(initialTalkCausalCueState(3), { type: "received", generation: 3, requestId: "message-1" });
    const failed = reduceTalkCausalCue(received, { type: "failed", generation: 3, requestId: "message-1" });
    const retried = reduceTalkCausalCue(failed, { type: "retry", generation: 3, requestId: "message-1" });
    const waiting = reduceTalkCausalCue(retried, { type: "waiting", generation: 3, requestId: "message-1" });
    const delivered = reduceTalkCausalCue(waiting, { type: "delivered", generation: 3, requestId: "message-1", replyGroupId: "retry-reply" });

    expect(retried.cue).toEqual({ phase: "received", requestId: "message-1" });
    expect(waiting.cue).toEqual({ phase: "waiting", requestId: "message-1" });
    expect(delivered.cue).toEqual({ phase: "delivered", requestId: "message-1", replyGroupId: "retry-reply" });
  });

  it("does not let an old request overwrite a newer received request", () => {
    const first = reduceTalkCausalCue(initialTalkCausalCueState(5), { type: "received", generation: 5, requestId: "message-1" });
    const firstDone = reduceTalkCausalCue(first, { type: "delivered", generation: 5, requestId: "message-1", replyGroupId: "reply-1" });
    const second = reduceTalkCausalCue(firstDone, { type: "received", generation: 5, requestId: "message-2" });
    const stale = reduceTalkCausalCue(second, { type: "waiting", generation: 5, requestId: "message-1" });

    expect(stale).toEqual(second);
    expect(stale.cue).toEqual({ phase: "received", requestId: "message-2" });
  });

  it("does not re-display an old terminal request after more than 32 later requests", () => {
    let state = initialTalkCausalCueState(6);
    for (let index = 0; index < 40; index += 1) {
      const requestId = `message-${index}`;
      state = reduceTalkCausalCue(state, { type: "received", generation: 6, requestId });
      state = reduceTalkCausalCue(state, { type: "failed", generation: 6, requestId });
    }

    expect(reduceTalkCausalCue(state, { type: "received", generation: 6, requestId: "message-0" })).toEqual(state);
  });

  it("keeps a duplicate waiting observation referentially stable", () => {
    const received = reduceTalkCausalCue(initialTalkCausalCueState(7), { type: "received", generation: 7, requestId: "message-1" });
    const waiting = reduceTalkCausalCue(received, { type: "waiting", generation: 7, requestId: "message-1" });

    expect(reduceTalkCausalCue(waiting, { type: "waiting", generation: 7, requestId: "message-1" })).toBe(waiting);
  });

  it("clears on a newer hydration generation and ignores older or unknown events", () => {
    const received = reduceTalkCausalCue(initialTalkCausalCueState(8), { type: "received", generation: 8, requestId: "message-1" });
    const reset = reduceTalkCausalCue(received, { type: "reset", generation: 9 });

    expect(reset).toEqual(initialTalkCausalCueState(9));
    expect(reduceTalkCausalCue(reset, { type: "received", generation: 8, requestId: "stale" })).toEqual(reset);
    expect(reduceTalkCausalCue(reset, { type: "unknown", generation: 9 } as never)).toEqual(reset);
    expect(reduceTalkCausalCue(reset, { type: "received", generation: 9, requestId: "" })).toEqual(reset);
  });
});
