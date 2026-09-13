import { useEffect, useRef, useState } from "react";
import { MenuPage } from "../components/MenuPage";
import { VrmStage } from "./VrmStage";
import { readVrmFile, type LocalVrm } from "./vrm-file";
import type { CharacterController } from "./vrm-preference";
import { ZUNDAMON_PORTRAIT } from "../live2d/zundamon-model-manifest";
import type { AvatarExpression, AvatarPreview } from "../live2d/avatar-contract";
import "./character-settings.css";
import { VRM_MOTIONS } from "./vrm-motion";

const faces: Array<{ label: string; value: AvatarExpression }> = [
  { label: "ふつう", value: "neutral" },
  { label: "笑顔", value: "smile" },
  { label: "驚く", value: "surprise" },
  { label: "悲しむ", value: "sad" },
  { label: "怒る", value: "angry" },
];
export function VrmModelSettings({controller,onBack}:{controller:CharacterController;onBack:()=>void}) {
  const { preference, save, ready, saving, error } = controller;
  const [pending, setPending] = useState<LocalVrm>(),
    [loading, setLoading] = useState(false),
    [fileError, setFileError] = useState<string>();
  const [renderState, setRenderState] = useState("loading"),
    [expression, setExpression] = useState<AvatarExpression>("neutral");
  const [motionPreview, setMotionPreview] = useState<AvatarPreview>();
  const [speaking, setSpeaking] = useState(false);
  const [storage, setStorage] = useState<"local" | "server">(
    preference.storage ?? "local",
  );
  useEffect(() => setStorage(preference.storage ?? "local"), [preference.storage]);
  const input = useRef<HTMLInputElement>(null),
    request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const model = pending ?? preference.model;
  const disabled = !ready || saving || loading;
  return <MenuPage title="VRMモデルの追加・管理" backLabel="キャラクターへ戻る" onBack={onBack} contentClassName="character-settings vrm-model-settings">
      <section aria-labelledby="vrm-import-title">
        <h2 id="vrm-import-title">VRMモデルを追加</h2>
        <p>利用できるモデルの .vrm ファイルを選んでください。50MBまで。</p>
        <p className="character-note">
          {storage === "server"
            ? "本人専用のサーバーに保存します。同じアカウントでMac・スマホから使えます。"
            : "このブラウザ内に保存します。別の端末には共有されません。"}
        </p>
        <fieldset className="character-storage" disabled={disabled}>
          <legend>モデルの保存先</legend>
          <label>
            <input
              type="radio"
              name="vrm-storage"
              checked={storage === "local"}
              onChange={() => setStorage("local")}
            />
            この端末に保存
          </label>
          <label>
            <input
              type="radio"
              name="vrm-storage"
              checked={storage === "server"}
              disabled={!controller.serverReady}
              onChange={() => setStorage("server")}
            />
            サーバーに保存
          </label>
        </fieldset>
        {!controller.serverConfigured ? (
          <p className="character-note">
            サーバー保存は、Supabaseを設定してログインすると使えます。
          </p>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={async () => {
              if (await controller.reloadServer()) {
                setPending(undefined);
                setStorage("server");
              }
            }}
          >
            サーバーから読み込む
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept=".vrm"
          aria-label="VRMファイルを選ぶ"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const id = ++request.current;
            setLoading(true);
            setFileError(undefined);
            try {
              const candidate = await readVrmFile(file);
              if (id === request.current) {
                setRenderState("loading");
                setPending(candidate);
                setExpression("neutral");
              }
            } catch (cause) {
              if (id === request.current)
                setFileError(
                  cause instanceof Error
                    ? cause.message
                    : "ファイルを読み込めませんでした。",
                );
            } finally {
              if (id === request.current) setLoading(false);
            }
          }}
        />
        <button
          className="character-file-button"
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {loading ? "ファイルを確認中…" : "VRMファイルを選ぶ"}
        </button>
        {fileError ? <p role="alert">{fileError}</p> : null}
      </section>
      {model ? (
        <section aria-label="VRMプレビュー">
          <div className="character-preview">
            <VrmStage
              key={model.id}
              model={model}
              enabled
              preview={motionPreview}
              onPreviewFinished={() => setMotionPreview(undefined)}
              interactive
              expression={expression}
              fallback={ZUNDAMON_PORTRAIT}
              audioSignal={{
                speechState: speaking ? "speaking" : "silent",
                volume: speaking ? 0.65 : 0,
              }}
              onStateChange={setRenderState}
            />
          </div>
          <p>
            <strong>{model.name}</strong> ／ {model.author}
          </p>
          <p className="character-note">
            {model.fileName} · VRM {model.version === "0" ? "0.0" : "1.0"}
          </p>
          {renderState === "loading" ? (
            <p role="status">モデルを読み込み中…</p>
          ) : null}
          {renderState === "failed" ? (
            <p role="alert">
              このモデルを表示できませんでした。別のファイルを選んでください。
            </p>
          ) : null}
          <div className="character-faces" role="group" aria-label="表情を試す">
            {faces.map((face) => (
              <button
                key={face.value}
                type="button"
                disabled={renderState !== "ready"}
                aria-pressed={expression === face.value}
                onClick={() => setExpression(face.value)}
              >
                {face.label}
              </button>
            ))}
            <button
              type="button"
              disabled={renderState !== "ready"}
              aria-pressed={speaking}
              onClick={() => setSpeaking((value) => !value)}
            >
              口パクを試す
            </button>
          </div>
          <div className="character-faces" role="group" aria-label="動きを試す">
            {VRM_MOTIONS.map((motion) => (
              <button
                key={motion.id}
                type="button"
                disabled={renderState !== "ready"}
                aria-pressed={motionPreview?.motion === motion.id}
                onClick={() => {
                  setExpression(motion.expression);
                  setMotionPreview({ motion: motion.id, requestId: performance.now(), loop: false });
                }}
              >
                {motion.label}
              </button>
            ))}
          </div>
          <p className="character-note">動きは1回再生して、自然に元の姿勢へ戻ります。</p>
          <p className="character-note">
            表情はモデルに含まれるものだけ反映されます。口パクのお試しは無音です。
          </p>
          {pending || storage !== (preference.storage ?? "local") ? (
            <div className="character-faces">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setPending(undefined);
                  setStorage(preference.storage ?? "local");
                }}
              >
                取り消す
              </button>
              <button
                type="button"
                disabled={disabled || renderState !== "ready"}
                onClick={async () => {
                  if (await save({ mode: "vrm", model, storage }))
                    setPending(undefined);
                }}
              >
                {saving
                  ? "保存中…"
                  : storage === "server"
                    ? "サーバーに保存して使う"
                    : "このモデルを使う"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {preference.model ? (
        <p className="character-note">
          現在の保存先：
          {preference.storage === "server"
            ? "サーバー（本人専用）"
            : "この端末"}
        </p>
      ) : null}
      {preference.model && !pending ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (
              window.confirm(
                preference.storage === "server"
                  ? "サーバーのVRMを削除してLive2Dに戻しますか？ 他の端末にも反映されます。"
                  : "この端末のVRMを削除してLive2Dに戻しますか？",
              )
            )
              void save({ mode: "live2d", storage: preference.storage });
          }}
        >
          保存したVRMを削除
        </button>
      ) : null}
      <p className="character-note">
        モデルの入手先例：
        <a
          href="https://hub.vroid.com/characters/2979905785202255395/models/2329704150518969205"
          target="_blank"
          rel="noreferrer"
        >
          しゆきさんのずんだもん
        </a>
        。モデルごとの利用条件を確認してご利用ください。
      </p>
      {saving ? <p role="status">モデルを保存中…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </MenuPage>;
}
