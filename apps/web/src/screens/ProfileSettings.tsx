import { WallpaperSettings } from "../components/WallpaperSettings";
import type { WallpaperController } from "../wallpaper";
import { MenuPage } from '../components/MenuPage';
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CaretRight } from "@phosphor-icons/react";
import type { AddressingStyle, Profile } from "@yui/domain";
import type { VisualStyle } from "../visual-style";
import { osNotificationPermissionLabel, type OsNotificationPermission } from "../proactive-message";

export type ProfileSettingsProps = {
  wallpaperController?: WallpaperController;
  profile: Profile;
  personalDetails?: { occupation: string; region: string };
  saving: boolean;
  error: string | null;
  onSave: (input: { displayName: string; addressingStyle: AddressingStyle; occupation?: string; region?: string }) => void;
  onClose: () => void;
  onOpenMemories: () => void;
  onOpenChatSearch?: () => void;
  onSignOut?: () => void;
  onUpdatePassword?: (password: string) => Promise<void>;
  initialPage?: "main" | "style" | "about";
  integratedSheet?: boolean;
  visualStyle?: VisualStyle;
  onVisualStyleChange?: (style: VisualStyle) => void;
  notificationSettings?: Readonly<{
    enabled: boolean;
    osPermission: OsNotificationPermission;
    onChange(enabled: boolean): Promise<void> | void;
  }>;
};

export function ProfileSettings({
  profile, personalDetails, saving, error, onSave, onClose, onOpenMemories, onOpenChatSearch, onSignOut, onUpdatePassword,
  wallpaperController,
  initialPage = "main",
  integratedSheet = false,
  notificationSettings,
}: ProfileSettingsProps) {
  const [page, setPage] = useState<"main" | "style" | "about">(initialPage);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [occupation, setOccupation] = useState(personalDetails?.occupation ?? "");
  const [region, setRegion] = useState(personalDetails?.region ?? "");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordState, setPasswordState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setDisplayName(profile.displayName);
  }, [profile]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || saving) return;
    onSave({ displayName: name, addressingStyle: profile.addressingStyle, ...(personalDetails ? {occupation, region} : {}) });
  };

  const updatePassword = () => {
    if (!onUpdatePassword || passwordState === "saving" || password.length < 8 || password !== passwordConfirmation) return;
    setPasswordState("saving");
    void onUpdatePassword(password).then(() => {
      setPassword("");
      setPasswordConfirmation("");
      setPasswordState("saved");
    }, () => setPasswordState("error"));
  };

  if (page !== "main") return <MenuPage title={page === "style" ? "壁紙" : "このアプリについて"} onBack={() => initialPage === "main" ? setPage("main") : onClose()} backLabel={initialPage === "main" ? "設定へ戻る" : "メニューへ戻る"}>
{page === "style" ? <>{wallpaperController ? <WallpaperSettings controller={wallpaperController} /> : null}</> : <><section className="settings-about">

          <p>ライフメイトAI ずんだもん</p>
          <p>ずんだもんという一人のAIと、同じ時間を暮らす。</p>
          <p>通話音声：VOICEVOX:ずんだもん ／ OpenAI Marin（接続設定による）</p>
          <p>音声はAIにより生成されています</p>
        </section></>}</MenuPage>;

  const Root = integratedSheet ? "section" : "main";
  const content = (
    <Root className={`profile-settings${integratedSheet ? " integrated-settings-sheet" : ""}`} role={integratedSheet ? "dialog" : undefined} aria-modal={integratedSheet || undefined} aria-labelledby="profile-settings-title">
      {integratedSheet ? <div className="integrated-sheet-handle" aria-hidden="true" /> : null}
      <header className="settings-header">
        <button type="button" aria-label="チャットに戻る" onClick={onClose} disabled={saving}><ArrowLeft aria-hidden="true" size={24} /></button>
        <h1 id="profile-settings-title">{integratedSheet ? "アプリ設定" : "設定"}</h1>
      </header>
      <form className="settings-content" onSubmit={handleSubmit}>
        <label htmlFor="profile-display-name">あなたの名前</label>
        <div className="profile-name-row">
        <input id="profile-display-name" value={displayName} maxLength={20} autoComplete="name" disabled={saving} onChange={(event) => setDisplayName(event.target.value)} />
          <button className="profile-name-save" type="submit" disabled={saving || !displayName.trim()}>保存する</button>
        </div>
        {personalDetails ? <div className="profile-personal-fields">
          <label htmlFor="profile-occupation">職業（任意）</label>
          <input id="profile-occupation" value={occupation} maxLength={120} disabled={saving} onChange={e => setOccupation(e.target.value)} placeholder="仕事や普段していること" />
          <label htmlFor="profile-region">住んでいる地域（任意）</label>
          <input id="profile-region" value={region} maxLength={120} disabled={saving} onChange={e => setRegion(e.target.value)} placeholder="都道府県・市区町村くらい" />
          <p>名前の横の「保存する」でまとめて保存します。</p>
        </div> : null}
        <button className="settings-link-row" type="button" aria-label="覚えたことを開く" onClick={onOpenMemories}><span>覚えたこと</span><CaretRight aria-hidden="true" size={20} /></button>
        <button className="settings-link-row" type="button" onClick={() => setPage("style")}><span>壁紙</span><CaretRight aria-hidden="true" size={20} /></button>
        {onOpenChatSearch ? <button className="settings-link-row" type="button" onClick={onOpenChatSearch}><span>トーク履歴を検索</span><CaretRight aria-hidden="true" size={20} /></button> : null}
        {notificationSettings ? <section className="settings-notifications" aria-labelledby="settings-notifications-title">
          <h2 id="settings-notifications-title">通知</h2>
          <label><input type="checkbox" checked={notificationSettings.enabled} onChange={(event) => void notificationSettings.onChange(event.target.checked)} />ずんだもんの通知</label>
          <p>{osNotificationPermissionLabel(notificationSettings.osPermission)}</p>
          <p>通知は端末の消音・通知要約など、OSの通知設定に従います。</p>
        </section> : null}
        {error ? <p role="alert">{error}</p> : null}
        {onUpdatePassword ? <section className="settings-password" aria-labelledby="settings-password-title">
          <h2 id="settings-password-title">ホーム画面からログイン</h2>
          <p>ホーム画面のChatずんだもんだけでログインできるように、8文字以上のパスワードを設定します。</p>
          <label htmlFor="settings-password">新しいパスワード</label>
          <input id="settings-password" type="password" value={password} autoComplete="new-password" disabled={saving || passwordState === "saving"} onChange={(event) => { setPassword(event.target.value); setPasswordState("idle"); }} />
          <label htmlFor="settings-password-confirmation">新しいパスワード（確認）</label>
          <input id="settings-password-confirmation" type="password" value={passwordConfirmation} autoComplete="new-password" disabled={saving || passwordState === "saving"} onChange={(event) => { setPasswordConfirmation(event.target.value); setPasswordState("idle"); }} />
          {passwordConfirmation && password !== passwordConfirmation ? <p role="alert">パスワードが一致していません。</p> : null}
          {passwordState === "error" ? <p role="alert">パスワードを設定できませんでした。もう一度お試しください。</p> : null}
          {passwordState === "saved" ? <p role="status">パスワードを設定しました。</p> : null}
          <button type="button" disabled={saving || passwordState === "saving" || password.length < 8 || password !== passwordConfirmation} onClick={updatePassword}>パスワードを設定</button>
        </section> : null}
        {onSignOut ? <button className="profile-signout-action" type="button" onClick={onSignOut} disabled={saving}>ログアウト</button> : null}
      </form>
    </Root>
  );
  return integratedSheet ? <div className="integrated-sheet-backdrop" role="presentation">{content}</div> : content;
}
