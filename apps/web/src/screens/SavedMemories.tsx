import { MenuPage } from '../components/MenuPage';
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import type { Memory } from "@yui/domain";
import type { MemoryApi, MemorySettings, MemoryTombstoneSummary } from "../api";

export type SavedMemoriesProps = {
  memoryApi: Pick<MemoryApi, "list" | "update" | "keep" | "forget" | "listTombstones" | "releaseTombstone" | "getSettings" | "updateSettings">;
  onClose: () => void;
  onOpenSource: (messageId: string) => boolean;
  onMemoryChanged: () => void;
  onSettingsChanged?: (settings: MemorySettings) => void;
  now?: () => Date;
};

type LoadState = "loading" | "ready" | "error";
type MemoryGroup = { key: string; title: string; memories: Memory[] };

const originLabels: Record<Memory["origin"], string> = {
  explicit: "頼まれて記憶",
  extracted: "会話から自動で記憶",
  manual: "手動で記憶",
  voice: "電話から記憶",
};
const scopeLabels: Record<Memory["scope"], string> = { daily: "日常", work: "仕事", shared: "共有" };

function dateLabel(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}

function groupMemories(memories: Memory[], now: Date): MemoryGroup[] {
  const recentCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recent = memories.filter((memory) => memory.status === "active" && Date.parse(memory.createdAt) >= recentCutoff);
  const recentIds = new Set(recent.map(({ id }) => id));
  return [
    { key: "recent", title: "最近覚えた", memories: recent },
    { key: "active", title: "今も覚えている", memories: memories.filter((memory) => memory.status === "active" && !recentIds.has(memory.id)) },
    { key: "past", title: "過去・期限切れ", memories: memories.filter((memory) => memory.status === "past" || memory.status === "expired") },
    { key: "uncertain", title: "まだ確かではない", memories: memories.filter((memory) => memory.status === "uncertain") },
  ].filter((group) => group.memories.length > 0);
}

export function SavedMemories({ memoryApi, onClose, onOpenSource, onMemoryChanged, onSettingsChanged, now = () => new Date() }: SavedMemoriesProps) {
  const [memoryLoadState, setMemoryLoadState] = useState<LoadState>("loading");
  const [tombstoneLoadState, setTombstoneLoadState] = useState<LoadState>("loading");
  const [settingsLoadState, setSettingsLoadState] = useState<LoadState>("loading");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [tombstones, setTombstones] = useState<MemoryTombstoneSummary[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<Memory | null>(null);
  const [blockRelearning, setBlockRelearning] = useState(true);
  const [revealedSensitive, setRevealedSensitive] = useState<Set<string>>(() => new Set());
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memoryGenerationRef = useRef(0);
  const tombstoneGenerationRef = useRef(0);
  const settingsGenerationRef = useRef(0);
  const editSaveRef = useRef<HTMLButtonElement>(null);
  const forgetButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const sourceButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const forgetDialogRef = useRef<HTMLElement>(null);
  const forgetCancelRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);

  const loadMemories = () => {
    const generation = ++memoryGenerationRef.current;
    setMemoryLoadState("loading");
    void memoryApi.list().then((items) => {
      if (memoryGenerationRef.current !== generation) return;
      setMemories(items);
      setMemoryLoadState("ready");
    }, () => {
      if (memoryGenerationRef.current !== generation) return;
      setMemoryLoadState("error");
    });
  };

  const loadTombstones = () => {
    const generation = ++tombstoneGenerationRef.current;
    setTombstoneLoadState("loading");
    void memoryApi.listTombstones().then((blocked) => {
      if (tombstoneGenerationRef.current !== generation) return;
      setTombstones(blocked);
      setTombstoneLoadState("ready");
    }, () => {
      if (tombstoneGenerationRef.current !== generation) return;
      setTombstoneLoadState("error");
    });
  };

  const loadSettings = () => {
    const generation = ++settingsGenerationRef.current;
    setSettingsLoadState("loading");
    void memoryApi.getSettings().then((loadedSettings) => {
      if (settingsGenerationRef.current !== generation) return;
      setSettings(loadedSettings);
      setSettingsLoadState("ready");
    }, () => {
      if (settingsGenerationRef.current !== generation) return;
      setSettingsLoadState("error");
    });
  };

  useEffect(() => {
    loadMemories();
    loadTombstones();
    loadSettings();
    return () => {
      memoryGenerationRef.current += 1;
      tombstoneGenerationRef.current += 1;
      settingsGenerationRef.current += 1;
    };
  }, [memoryApi]);

  useEffect(() => {
    if (forgetting) queueMicrotask(() => forgetCancelRef.current?.focus());
  }, [forgetting]);

  const groups = useMemo(() => groupMemories(memories, now()), [memories, now]);

  const beginEdit = (memory: Memory) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setError(null);
  };

  const saveEdit = async (memory: Memory) => {
    const content = editContent.trim();
    if (!content || savingId) return;
    setSavingId(memory.id);
    setError(null);
    try {
      const updated = await memoryApi.update(memory.id, { content });
      setMemories((current) => current.map((item) => item.id === memory.id ? updated : item));
      setEditingId(null);
      onMemoryChanged();
    } catch {
      setError("内容を保存できませんでした。もう一度お試しください。");
      queueMicrotask(() => editSaveRef.current?.focus());
    } finally {
      setSavingId(null);
    }
  };

  const pin = async (memory: Memory) => {
    if (savingId) return;
    setSavingId(memory.id);
    setError(null);
    try {
      const updated = await memoryApi.update(memory.id, { pinned: true });
      setMemories((current) => current.map((item) => item.id === memory.id ? updated : item));
      onMemoryChanged();
    } catch {
      setError("期限なしに変更できませんでした。もう一度お試しください。");
    } finally {
      setSavingId(null);
    }
  };

  const keep = async (memory: Memory) => {
    if (savingId) return;
    setSavingId(memory.id);
    setError(null);
    try {
      const updated = await memoryApi.keep(memory.id);
      setMemories((current) => current.map((item) => item.id === memory.id ? updated : item));
      onMemoryChanged();
    } catch {
      setError("この記憶を会話で使える状態にできませんでした。もう一度お試しください。");
    } finally {
      setSavingId(null);
    }
  };

  const forget = async () => {
    const target = forgetting;
    if (!target || savingId) return;
    setForgetting(null);
    setSavingId(target.id);
    setError(null);
    try {
      await memoryApi.forget(target.id, blockRelearning);
    } catch {
      setError("この記憶を忘れられませんでした。もう一度お試しください。");
      setSavingId(null);
      window.setTimeout(() => forgetButtonsRef.current.get(target.id)?.focus(), 0);
      return;
    }
    const targetIndex = memories.findIndex(({ id }) => id === target.id);
    const nextMemory = memories[targetIndex + 1] ?? memories[targetIndex - 1];
    setMemories((current) => current.filter(({ id }) => id !== target.id));
    onMemoryChanged();
    if (blockRelearning) {
      try {
        setTombstones(await memoryApi.listTombstones());
      } catch {
        setError("記憶は忘れましたが、再学習防止の状態を更新できませんでした。画面を読み込み直してください。");
      }
    }
    setSavingId(null);
    window.setTimeout(() => {
      if (nextMemory) forgetButtonsRef.current.get(nextMemory.id)?.focus();
      else backButtonRef.current?.focus();
    }, 0);
  };

  const release = async (tombstone: MemoryTombstoneSummary) => {
    setError(null);
    try {
      await memoryApi.releaseTombstone(tombstone.id);
      setTombstones((current) => current.filter(({ id }) => id !== tombstone.id));
      onMemoryChanged();
    } catch {
      setError("再び覚えられる状態に戻せませんでした。もう一度お試しください。");
    }
  };

  const toggleSetting = async () => {
    if (!settings || savingId === "settings") return;
    const next = { memoryEnabled: !settings.memoryEnabled };
    setSavingId("settings");
    setError(null);
    try {
      const updated = await memoryApi.updateSettings(next);
      setSettings(updated);
      onSettingsChanged?.(updated);
    } catch {
      setError("記憶の設定を保存できませんでした。もう一度お試しください。");
    } finally {
      setSavingId(null);
    }
  };

  const openSource = (memoryId: string, messageId: string) => {
    setSourceMessage(null);
    if (!onOpenSource(messageId)) {
      setSourceMessage("元の会話はありません");
      queueMicrotask(() => sourceButtonsRef.current.get(memoryId)?.focus());
    }
  };

  const closeForgetDialog = () => {
    if (!forgetting) return;
    const id = forgetting.id;
    setForgetting(null);
    queueMicrotask(() => forgetButtonsRef.current.get(id)?.focus());
  };

  const handleForgetDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeForgetDialog();
      return;
    }
    if (event.key !== "Tab" || !forgetDialogRef.current) return;
    const focusable = Array.from(forgetDialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
  };

  return (
    <MenuPage backRef={backButtonRef} title="覚えていること" onBack={onClose} backLabel="プロフィールへ戻る" busy={savingId !== null} contentClassName="memory-records">
      <section className="saved-memories-content">
        <p className="saved-memories-description">ずんだもんが覚えている内容を確認し、直したり忘れさせたりできます。</p>
        {memoryLoadState === "loading" ? <p role="status">覚えたことを読み込んでいます</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {sourceMessage ? <p role="status">{sourceMessage}</p> : null}
        {memoryLoadState === "error" ? <p role="alert">覚えたことを読み込めませんでした。<button className="memory-primary-action" type="button" onClick={loadMemories}>覚えたことを再読み込み</button></p> : null}
        {settingsLoadState === "error" ? <p role="alert">記憶の設定を読み込めませんでした。<button className="memory-primary-action" type="button" onClick={loadSettings}>記憶の設定を再読み込み</button></p> : null}
        {tombstoneLoadState === "error" ? <p role="alert">再学習防止の状態を読み込めませんでした。<button className="memory-primary-action" type="button" onClick={loadTombstones}>再学習防止の状態を再読み込み</button></p> : null}
        {settingsLoadState === "ready" && settings ? <section className="memory-settings" aria-labelledby="memory-settings-title">
          <h2 id="memory-settings-title">ずんだもんの記憶</h2>
          <div className="memory-setting-row"><span><strong>ずんだもんの記憶</strong><small>OFFでも保存済みの内容は消えず、確認や整理を続けられます</small></span><button type="button" role="switch" aria-label="ずんだもんの記憶" aria-checked={settings.memoryEnabled} disabled={savingId === "settings"} onClick={() => void toggleSetting()}>{settings.memoryEnabled ? "ON" : "OFF"}</button></div>
        </section> : null}
        {memoryLoadState === "ready" && memories.length === 0 ? <p className="saved-memories-empty">まだ覚えていることはありません</p> : null}
        {memoryLoadState === "ready" ? groups.map((group) => <section className="memory-group" aria-labelledby={`memory-group-${group.key}`} key={group.key}>
          <h2 id={`memory-group-${group.key}`}>{group.title}</h2>
          <ul className="saved-memory-list">{group.memories.map((memory) => {
            const sensitiveHidden = memory.sensitivity === "sensitive" && !revealedSensitive.has(memory.id);
            const busy = savingId === memory.id;
            return <li className="saved-memory-card" key={memory.id}>
              {editingId === memory.id ? <div className="memory-edit-form">
                <label htmlFor={`memory-edit-${memory.id}`}>記憶の内容</label>
                <textarea id={`memory-edit-${memory.id}`} maxLength={200} value={editContent} disabled={busy} onChange={(event) => setEditContent(event.target.value)} />
                <div><button type="button" disabled={busy} onClick={() => { setEditingId(null); setError(null); }}>編集をキャンセル</button><button ref={editSaveRef} type="button" disabled={busy || !editContent.trim()} onClick={() => void saveEdit(memory)}>編集を保存</button></div>
              </div> : <>
                <p className="memory-content">{sensitiveHidden ? "敏感な内容は非表示です" : memory.content}</p>
                {memory.sensitivity === "sensitive" ? <button className="memory-text-action" type="button" onClick={() => setRevealedSensitive((current) => { const next = new Set(current); if (next.has(memory.id)) next.delete(memory.id); else next.add(memory.id); return next; })}>{sensitiveHidden ? "敏感な内容を表示" : "敏感な内容を隠す"}</button> : null}
                <p className="memory-meta"><span>{originLabels[memory.origin]}</span><span>{scopeLabels[memory.scope]}</span>{dateLabel(memory.sourceOccurredAt ?? memory.createdAt) ? <time dateTime={memory.sourceOccurredAt ?? memory.createdAt}>{dateLabel(memory.sourceOccurredAt ?? memory.createdAt)}</time> : null}</p>
                {memory.reviewState === "needs_review" ? <p className="memory-review-note">会話ではまだ使いません。内容を確認してから使えます。</p> : null}
                <div className="memory-actions">
                  {memory.reviewState === "needs_review" ? <button type="button" disabled={busy} aria-label="この記憶を会話で使う" onClick={() => void keep(memory)}>会話で使う</button> : null}
                  <button type="button" disabled={busy} aria-label={sensitiveHidden ? "非表示の記憶の内容を編集" : `${memory.content}の内容を編集`} onClick={() => beginEdit(memory)}>編集</button>
                  {!memory.pinned && memory.status === "active" ? <button type="button" disabled={busy} aria-label={sensitiveHidden ? "非表示の記憶を期限なしで残す" : `${memory.content}を期限なしで残す`} onClick={() => void pin(memory)}>期限なしで残す</button> : null}
                  <button ref={(node) => { if (node) forgetButtonsRef.current.set(memory.id, node); else forgetButtonsRef.current.delete(memory.id); }} type="button" disabled={busy} aria-label={sensitiveHidden ? "非表示の記憶を忘れる" : `${memory.content}を忘れる`} onClick={() => { setForgetting(memory); setBlockRelearning(true); setError(null); }}>忘れる</button>
                </div>
                {memory.sourceMessageId ? <button ref={(node) => { if (node) sourceButtonsRef.current.set(memory.id, node); else sourceButtonsRef.current.delete(memory.id); }} className="memory-source-action" data-source-id={memory.sourceMessageId} type="button" onClick={() => openSource(memory.id, memory.sourceMessageId!)}>元の会話を見る</button> : <p className="memory-source-missing">元の会話はありません</p>}
              </>}
            </li>;
          })}</ul>
        </section>) : null}
        {tombstoneLoadState === "ready" && tombstones.length > 0 ? <section className="memory-group" aria-labelledby="memory-tombstone-title"><h2 id="memory-tombstone-title">再び覚えてよいもの</h2><p>自動で覚え直さないようにした内容を解除できます。</p><ul className="memory-tombstone-list">{tombstones.map((tombstone) => <li key={tombstone.id}><span>{dateLabel(tombstone.createdAt)}に忘れた記憶</span><button type="button" onClick={() => void release(tombstone)}>再記憶禁止を解除</button></li>)}</ul></section> : null}
      </section>
      {forgetting ? <div className="memory-delete-backdrop"><section ref={forgetDialogRef} className="memory-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-delete-title" onKeyDown={handleForgetDialogKeyDown}><h2 id="memory-delete-title">この記憶を忘れますか</h2><p>ずんだもんはこの内容を会話で使わなくなります。</p><label><input type="checkbox" checked={blockRelearning} onChange={(event) => setBlockRelearning(event.target.checked)} />同じ内容を会話から再び覚えない</label><div><button ref={forgetCancelRef} type="button" onClick={closeForgetDialog}>キャンセル</button><button type="button" onClick={() => void forget()}>忘れる</button></div></section></div> : null}
    </MenuPage>
  );
}
