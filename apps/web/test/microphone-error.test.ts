import { describe, expect, it } from "vitest";
import { microphoneFailureMessage } from "../src/microphone-error";

describe("microphone failure guidance", () => {
  it("explains how to recover when iPhone microphone permission is denied", () => {
    const denied = new DOMException("permission denied", "NotAllowedError");

    expect(microphoneFailureMessage(denied, "dictation")).toBe(
      "iPhoneの設定でChatずんだもんのマイクを許可して、もう一度お試しください。",
    );
    expect(microphoneFailureMessage(denied, "call")).toBe(
      "通話にはマイクの許可が必要です。iPhoneの設定でChatずんだもんのマイクを許可してください。",
    );
  });

  it("keeps a safe generic message for non-permission failures", () => {
    expect(microphoneFailureMessage(new Error("network"), "dictation")).toBe(
      "音声入力に失敗しました。もう一度お試しください。",
    );
    expect(microphoneFailureMessage(new Error("network"), "call")).toBe(
      "ずんだもんとの接続に失敗しました。マイクは停止しています",
    );
  });
});
