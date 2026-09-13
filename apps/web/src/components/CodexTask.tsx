import { useCallback, useEffect, useRef, useState } from 'react';
import { codexWorking, type CodexApi, type CodexJob } from '../codex';
import './codex-task.css';
import { CodexConfirmation } from './CodexConfirmation';
export function useCodexTask(api?: CodexApi, scope = 'local') {
  const key = 'zundamon:codex-dismissed:' + scope;
  const readDismissed = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  useEffect(() => { setDismissed(readDismissed()); }, [key]);
  const [job, setJob] = useState<CodexJob | null>(null);
  const [error, setError] = useState('');
  const jobUpdates = useRef(0);
  const onJob = useCallback((next: CodexJob) => {
    jobUpdates.current += 1;
    setJob(current => !current || current.id !== next.id || current.updatedAt <= next.updatedAt ? next : current);
  }, []);
  useEffect(() => {
    const restoreVersion = ++jobUpdates.current;
    setJob(null); setError('');
    if (!api) return;
    const abort = new AbortController();
    void api.status().then(status => status.enabled ? api.latest(abort.signal) : null).then(next => {
      // A reinstalled PWA has no dismissal cache. Only unfinished work belongs on its home screen.
      // A slow startup response must not overwrite work requested in this session.
      if (!abort.signal.aborted && restoreVersion === jobUpdates.current && next && codexWorking(next)) onJob(next);
    }).catch(() => {});
    return () => abort.abort();
  }, [api, scope, onJob]);
  useEffect(() => {
    if (!api || !job || !codexWorking(job)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.get(job.requestId, abort.signal); if (!abort.signal.aborted) { onJob(next); setError(current => current.startsWith("作業状況を確認できません") ? "" : current); } }
      catch { if (!abort.signal.aborted) setError('作業状況を確認できません。接続が戻ると再確認します。'); }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [api, job?.requestId, job?.status, onJob]);
  const dismiss = () => {
    if (!job || codexWorking(job)) return;
    setDismissed(job.id);
    try { localStorage.setItem(key, job.id); } catch { /* Keep it dismissed for this session. */ }
  };
  return { job, visibleJob: job && (codexWorking(job) || job.id !== dismissed) ? job : null, dismiss, onJob, error, setError };
}
export function CodexTask({ job, api, error, onError, onJob, onResult, onDismiss, busy }: {
  job: CodexJob | null; api?: CodexApi; error: string; onError: (error: string) => void;
  onJob: (job: CodexJob) => void; onResult: () => void; onDismiss: () => void; busy: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!job || !api) return null;
  return <section className={`codex-task${codexWorking(job) ? ' is-working' : ''}`} aria-label="Codexの作業">
    <div className="codex-task-row">
      <div><strong>Codex{job.projectName ? <small>{job.projectName}</small> : null}</strong><p role="status">{job.message}</p></div>
      {codexWorking(job) ? <button type="button" disabled={stopping} onClick={async () => {
        setStopping(true); onError('');
        try { onJob(await api.cancel(job.requestId)); }
        catch { onError('停止を確認できませんでした。接続を確認して、もう一度停止してください。'); }
        finally { setStopping(false); }
      }}>{stopping ? '停止中…' : '作業を停止'}</button> : <button type="button" aria-label="Codexの作業表示を閉じる" onClick={onDismiss}>閉じる</button>}
    </div>
    {job.pending?.length ? <button className="codex-task-confirm" type="button" onClick={() => setConfirming(true)}>Codexの確認に回答 ({job.pending.length})</button> : null}
    {confirming && job.pending?.[0] ? <CodexConfirmation key={job.pending[0].id} request={job.pending[0]} onClose={() => setConfirming(false)} onAnswer={async answer => { const next = await api.answer(job.requestId, job.pending![0].id, answer); onJob(next); if (!next.pending?.length) setConfirming(false); }} /> : null}
    {error ? <p role="alert">{error}</p> : null}
    {job.result ? <div className="codex-task-results"><button type="button" disabled={busy} onClick={onResult}>結果をトークに表示</button><details><summary>全文</summary><div className="codex-task-full">{job.result}</div></details></div> : null}
  </section>;
}
