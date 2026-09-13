export type PhotoPresentationStage =
  | "preparing"
  | "confirming"
  | "sending"
  | "committing"
  | "retryable_error"
  | "terminal_error";

export type PhotoPresentationError =
  | "unsupported_photo"
  | "photo_too_large"
  | "photo_preparation_failed"
  | "photo_send_failed"
  | "photo_save_unconfirmed"
  | "photo_result_unknown";

const PHOTO_MESSAGES: Readonly<Record<PhotoPresentationError, string>> = {
  unsupported_photo: "この写真形式は使えません。JPEGまたはHEICを選んでください。",
  photo_too_large: "写真が大きすぎます。別の写真を選んでください。",
  photo_preparation_failed: "写真を準備できませんでした。別の写真で試してください。",
  photo_send_failed: "写真を送信できませんでした。もう一度試してください。",
  photo_save_unconfirmed: "写真は受信済みですが、会話への保存を確認できませんでした。同じ写真を送り直さず、保存だけ再試行できます。",
  photo_result_unknown: "送信結果を確認できませんでした。追加送信せず、もう一度確認してください。",
};

export function classifyPhotoPreparationError(error: unknown): PhotoPresentationError {
  if (error instanceof Error && error.message === "unsupported_photo") return "unsupported_photo";
  if (error instanceof Error && ["photo_too_large", "photo_input_too_large", "photo_output_too_large"].includes(error.message)) return "photo_too_large";
  return "photo_preparation_failed";
}

export function photoPresentationMessage(error: PhotoPresentationError): string {
  return PHOTO_MESSAGES[error];
}

export function photoProgressMessage(stage: PhotoProgressStage): string | null {
  if (stage === "sending") return "写真を送信しています";
  if (stage === "committing") return "会話に保存しています";
  return null;
}

export function photoProgressError(stage: PhotoProgressStage): PhotoPresentationError | null {
  if (stage === "retryable") return "photo_send_failed";
  if (stage === "commit_retryable") return "photo_save_unconfirmed";
  if (stage === "terminal") return "photo_result_unknown";
  return null;
}
import type { PhotoProgressStage } from "./chat-controller";
