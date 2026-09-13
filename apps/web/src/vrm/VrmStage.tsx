import { useMemo } from "react";
import { AvatarStage, type AvatarStageProps } from "../live2d/AvatarStage";
import type { LocalVrm } from "./vrm-file";
import "./character-settings.css";

export function VrmStage({
  model,
  ...props
}: Omit<AvatarStageProps, "manifest" | "loadRenderer" | "rendererSource"> & {
  model: LocalVrm;
}) {
  const source = useMemo(
    () => ({
      load: async (canvas: HTMLCanvasElement, signal: AbortSignal) => {
        const { loadVrmRenderer } = await import("./vrm-renderer");
        return loadVrmRenderer(canvas, model.data, signal);
      },
    }),
    [model],
  );
  return (
    <AvatarStage
      {...props}
      key={model.id}
      className="vrm-avatar-stage"
      interactionMode="orbit"
      loadingNotice="キャラクターを読み込み中…"
      rendererSource={source}
      fallbackNotice="VRMを表示できないため、静止画で表示しています。キャラクター設定からLive2Dに戻せます。"
    />
  );
}
