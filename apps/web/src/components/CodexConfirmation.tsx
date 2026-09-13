import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CodexAnswer, CodexPendingRequest } from '@yui/domain';

export function CodexConfirmation({ request, onClose, onAnswer }: { request: CodexPendingRequest; onClose: () => void; onAnswer: (answer: CodexAnswer) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async (choice: string) => {
    setBusy(true); setError('');
    try { await onAnswer({ choice, answers }); }
    catch (e) { setError(e instanceof Error ? e.message : '回答を送れませんでした。'); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="codex-confirmation" aria-labelledby="codex-confirm-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="codex-confirm-title">{request.title}</h2><button type="button" onClick={onClose} aria-label="確認を閉じる">閉じる</button></header>
    <div className="codex-confirmation-body">
      {request.details ? <pre>{request.details}</pre> : null}
      {request.url ? <a href={request.url} target="_blank" rel="noopener noreferrer">確認画面を開く ↗</a> : null}
      {request.questions?.map(q => <fieldset key={q.id}>
        <legend>{q.question}</legend>
        {q.options?.length ? <div className="codex-answer-options">{q.options.map(option => <button type="button" key={option} aria-pressed={answers[q.id] === option} onClick={() => setAnswers(current => ({ ...current, [q.id]: option }))}>{option}</button>)}</div> : null}
        <input type={q.secret ? 'password' : q.type === 'number' || q.type === 'integer' ? 'number' : 'text'} aria-label={q.question} autoComplete="off" value={answers[q.id] ?? ''} placeholder={q.options?.length ? '選択、または入力' : '回答を入力'} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))} />
      </fieldset>)}
      {error ? <p role="alert">{error}</p> : null}
    </div>
    <footer>{request.choices.map(c => <button key={c.id} type="button" disabled={busy || (c.id === 'send' || c.id === 'accept') && !!request.questions?.some(q => q.required && !answers[q.id]?.trim())} onClick={() => void submit(c.id)}>{c.label}</button>)}</footer>
  </dialog>, document.body);
}
