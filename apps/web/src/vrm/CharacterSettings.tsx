import { CaretRight } from "@phosphor-icons/react";
import { MenuPage } from "../components/MenuPage";
import type { CharacterController } from "./vrm-preference";
import "./character-settings.css";

export function CharacterSettings({controller,onBack,onOpenMotions,onOpenVrm}:{
  controller:CharacterController;
  onBack:()=>void;
  onOpenMotions?:()=>void;
  onOpenVrm:()=>void;
}) {
  const {preference,save,ready,saving,error}=controller;
  const disabled=!ready || saving;
  return <MenuPage title="キャラクター" onBack={onBack} contentClassName="character-settings">
      <p>Live2Dと3Dモデルを切り替えられます。</p>
      <div
        className="character-options"
        role="group"
        aria-label="表示するキャラクター"
      >
        <button
          type="button"
          disabled={disabled}
          aria-pressed={preference.mode === "live2d"}
          onClick={() => void save({ ...preference, mode: "live2d" })}
        >
          <strong>Live2D</strong>
          <span>いつものずんだもん</span>
        </button>
        <button
          type="button"
          disabled={disabled || !preference.model}
          aria-pressed={preference.mode === "vrm"}
          onClick={() => void save({ ...preference, mode: "vrm" })}
        >
          <strong>VRM</strong>
          <span>{preference.model?.name ?? "ファイルを選んで追加"}</span>
        </button>
      </div>
      <section className="character-detail-settings" aria-labelledby="character-detail-title">
        <h2 id="character-detail-title">動き・モデルの設定</h2>
        <ul className="app-menu-list character-detail-links">
          {onOpenMotions ? <li><button type="button" onClick={onOpenMotions}>
            <span><strong>Live2Dのモーション</strong><span className="character-note">表情やポーズを試す</span></span>
            <CaretRight size={20} aria-hidden="true" />
          </button></li> : null}
          <li><button type="button" onClick={onOpenVrm}>
            <span><strong>VRMモデルの追加・管理</strong><span className="character-note">ファイル・保存先・動きの確認</span></span>
            <CaretRight size={20} aria-hidden="true" />
          </button></li>
        </ul>
      </section>
      {saving ? <p role="status">設定を保存中…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </MenuPage>;
}
