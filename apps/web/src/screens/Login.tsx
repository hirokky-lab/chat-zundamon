import { ZUNDAMON_CHARACTER } from "@yui/domain";
import { useState, type FormEvent } from "react";
import type { AuthClient, AuthSession } from "../auth";

export type LoginProps = {
  authClient: AuthClient;
  onAuthenticated: (session: AuthSession) => void;
};

export function Login({ authClient, onAuthenticated }: LoginProps) {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithGoogle = async () => {
    if (!authClient.signInWithGoogle || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authClient.signInWithGoogle();
    } catch {
      setError("Googleでログインできませんでした。もう一度お試しください。");
      setBusy(false);
    }
  };

  const requestLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authClient.requestOtp(normalizedEmail);
      setEmail(normalizedEmail);
      setLinkSent(true);
    } catch {
      setError("ログインリンクを送信できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await authClient.signInWithPassword(normalizedEmail, password));
    } catch {
      setError("ログインできませんでした。入力内容を確認してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-card" aria-label={`${ZUNDAMON_CHARACTER.displayName}のログイン`}>
        <div className="setup-welcome-scene">
          <div className="setup-dialogue">
            <p className="setup-speech">いっしょに、お話しするのだ。</p>
          </div>
          <img className="setup-character" src="/characters/zundamon/sakamoto-ahiru-welcome.png" alt="にっこり笑って手を挙げるずんだもん" />
        </div>
        {authClient.signInWithGoogle ? <button className="login-google-action" type="button" disabled={busy} onClick={() => void signInWithGoogle()}><svg className="google-brand-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.05.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg><span>Googleでログイン</span></button> : null}
        {authClient.signInWithGoogle ? null : mode === "password" ? <>
          <form onSubmit={(event) => void signIn(event)}>
            <label htmlFor="login-email">メールアドレス</label>
            <input id="login-email" type="email" value={email} autoComplete="email" required disabled={busy} onChange={(event) => setEmail(event.target.value)} />
            <label htmlFor="login-password">パスワード</label>
            <input id="login-password" type="password" value={password} autoComplete="current-password" required disabled={busy} onChange={(event) => setPassword(event.target.value)} />
            <button type="submit" disabled={busy || !email.trim() || !password}>ログイン</button>
          </form>
          <button className="login-secondary-action" type="button" disabled={busy} onClick={() => { setMode("link"); setError(null); }}>ログインリンクを使う</button>
        </> : !linkSent ? (
          <form onSubmit={(event) => void requestLink(event)}>
            <label htmlFor="login-email">メールアドレス</label>
            <input id="login-email" type="email" value={email} autoComplete="email" required disabled={busy} onChange={(event) => setEmail(event.target.value)} />
            <button type="submit" disabled={busy || !email.trim()}>ログインリンクを受け取る</button>
          </form>
        ) : (
          <p role="status">ログインリンクを送信しました。メール内のリンクを開いてください。</p>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
