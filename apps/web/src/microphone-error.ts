export type MicrophoneUse = "dictation" | "call";

function isPermissionFailure(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === "NotAllowedError" || cause.name === "SecurityError"
    : cause instanceof Error
      && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
}

export function microphoneFailureMessage(cause: unknown, use: MicrophoneUse): string {
  if (isPermissionFailure(cause)) {
    return use === "dictation"
      ? "iPhoneの設定でChatずんだもんのマイクを許可して、もう一度お試しください。"
      : "通話にはマイクの許可が必要です。iPhoneの設定でChatずんだもんのマイクを許可してください。";
  }
  return use === "dictation"
    ? "音声入力に失敗しました。もう一度お試しください。"
    : "ずんだもんとの接続に失敗しました。マイクは停止しています";
}
