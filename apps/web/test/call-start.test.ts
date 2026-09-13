import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_START_TIMEOUT_MS,
  createCallStartAttempt,
  finishCallStart,
} from "../src/call-start";

describe("call start lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops and clears exactly once on timeout", () => {
    const client = { start: vi.fn(async () => undefined), stop: vi.fn() };
    const onTimeout = vi.fn();
    const attempt = createCallStartAttempt(3, client, onTimeout);

    vi.advanceTimersByTime(CALL_START_TIMEOUT_MS);

    expect(client.stop).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith(3);
    finishCallStart(attempt);
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("clears the timeout without stopping a connected client", () => {
    const client = { start: vi.fn(async () => undefined), stop: vi.fn() };
    const onTimeout = vi.fn();
    const attempt = createCallStartAttempt(4, client, onTimeout);

    finishCallStart(attempt, "connected");
    vi.advanceTimersByTime(CALL_START_TIMEOUT_MS);

    expect(client.stop).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops once when a pending attempt fails before its timeout", () => {
    const client = { start: vi.fn(async () => undefined), stop: vi.fn() };
    const onTimeout = vi.fn();
    const attempt = createCallStartAttempt(5, client, onTimeout);

    finishCallStart(attempt, "failed");
    finishCallStart(attempt, "failed");
    vi.advanceTimersByTime(CALL_START_TIMEOUT_MS);

    expect(client.stop).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
