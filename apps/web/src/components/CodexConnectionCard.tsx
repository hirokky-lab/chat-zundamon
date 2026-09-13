import { useEffect, useState } from 'react';
import { TerminalWindow } from '@phosphor-icons/react';
import type { CodexApi } from '../codex';

export function CodexConnectionCard({ api }: { api: CodexApi }) {
  const [status, setStatus] = useState<Awaited<ReturnType<CodexApi['status']>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api.status().then(value => { if (alive) setStatus(value); }).catch(() => { if (alive) setError('Codexの接続状態を確認できませんでした。'); });
    return () => { alive = false; };
  }, [api]);
  return <section className="google-connection-card" aria-label="Codexの接続">
    <div className="google-connection-title"><TerminalWindow size={28} /><div><h2>Codex</h2><span>{status ? !status.enabled ? '未設定' : status.connected ? '接続済み' : '接続できません' : error ? '確認できません' : '確認中'}</span></div></div>
    <p>プロジェクトの作業や調査を頼めます。進捗・確認事項・結果はトークに返ります。</p>
    {status?.connected ? <p className="google-connection-note">登録プロジェクト：{status.projectCount}件{status.model ? <><br />モデル：{status.model}</> : null}</p> : null}
    <p className="google-connection-note">このMacにログインしているCodexの設定を使います。Macとアプリのサーバーが起動している間に利用できます。</p>
    {status && !status.enabled ? <p>このサーバーではCodex連携が未設定です。</p> : null}
    {status?.message ? <p role="status">{status.message}</p> : null}
    <button className="ai-secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { setStatus(await api.status()); } catch { setError('接続を確認できませんでした。もう一度お試しください。'); }
      finally { setBusy(false); }
    }}>{busy ? '確認中…' : 'Codexの接続を確認'}</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
