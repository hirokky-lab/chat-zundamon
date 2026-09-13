import { describe, expect, it } from "vitest";
import {
  classifyPhotoPreparationError,
  photoProgressError,
  photoProgressMessage,
  photoPresentationMessage,
} from "../src/photo-presentation";

describe("photo presentation errors", () => {
  it.each([
    [new Error("unsupported_photo"), "unsupported_photo"],
    [new Error("photo_too_large"), "photo_too_large"],
    [new Error("photo_input_too_large"), "photo_too_large"],
    [new Error("photo_output_too_large"), "photo_too_large"],
    [new Error("raw provider text"), "photo_preparation_failed"],
    [null, "photo_preparation_failed"],
  ] as const)("normalizes preparation failure without exposing raw details", (error, expected) => {
    const reason = classifyPhotoPreparationError(error);

    expect(reason).toBe(expected);
    expect(photoPresentationMessage(reason)).not.toContain("raw provider text");
  });

  it("uses fixed actionable Japanese messages", () => {
    expect(photoPresentationMessage("unsupported_photo")).toBe(
      "この写真形式は使えません。JPEGまたはHEICを選んでください。",
    );
    expect(photoPresentationMessage("photo_too_large")).toBe(
      "写真が大きすぎます。別の写真を選んでください。",
    );
    expect(photoPresentationMessage("photo_preparation_failed")).toBe(
      "写真を準備できませんでした。別の写真で試してください。",
    );
  });

  it("distinguishes provider send from durable conversation commit", () => {
    expect(photoProgressMessage("sending")).toBe("写真を送信しています");
    expect(photoProgressMessage("committing")).toBe("会話に保存しています");
    expect(photoProgressMessage("completed")).toBeNull();
    expect(photoProgressMessage("retryable")).toBeNull();
    expect(photoProgressMessage("terminal")).toBeNull();
  });

  it("maps retryable and ambiguous delivery stages to fixed safe alerts", () => {
    expect(photoProgressError("retryable")).toBe("photo_send_failed");
    expect(photoProgressError("terminal")).toBe("photo_result_unknown");
    expect(photoProgressError("sending")).toBeNull();
    expect(photoProgressError("committing")).toBeNull();
    expect(photoProgressError("completed")).toBeNull();
  });
});
