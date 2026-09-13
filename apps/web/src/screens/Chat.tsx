import {BgmHeader} from '../bgm/BgmHeader';
import type {BgmController} from '../bgm/use-bgm';
import { StageSpeech } from "../components/StageSpeech";
import { ZUNDAMON_CHARACTER } from "@yui/domain";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Camera, ChatCircleText, Images, GearSix, List, MagnifyingGlass, Microphone, Phone, Plus, UserCircle, Stop, Waveform, X } from "@phosphor-icons/react";
import { HamburgerMenuIcon, PersonIcon, PlusIcon } from "@radix-ui/react-icons";
import type { ChatState } from "../chat-controller";
import type { YuiRequestErrorKind } from "../api";
import type { DictationState } from "../dictation";
import { shouldUseWebSearch, type CallCard, type TimelineItem } from "@yui/domain";
import { reduceChatFollow, type ChatFollowState } from "../chat-follow";
import { searchChatHistory, selectInitialResult } from "../chat-history-search";
import { applyChatOverlayInsets } from "../chat-overlays";
import { useIntegratedSwipe } from "../integrated-swipe";
import type { ProactiveUiAction } from "../proactive-message";
import type { TalkCausalCue } from "../talk-causal-cue";
import type { VisualStyle } from "../visual-style";
import "../chat-refresh.css";
import "../zundamon.css";
import "../desktop-conversation.css";
import { stageDialogue, stageLinks } from "../stage-dialogue";

const REPLY_FIRST_BUBBLE_DELAY_MS = 400;
const REPLY_BUBBLE_INTERVAL_MS = 350;
const COMPOSER_SINGLE_LINE_HEIGHT_PX = 32;
const COMPOSER_MAX_HEIGHT_PX = 120;
const chatFailureMessage = {
  authentication: "ログイン状態を確認して、もう一度お試しください",
  "profile-required": "プロフィールの設定を確認して、もう一度お試しください",
  "usage-limit": "現在、利用上限に達しています。運営側の設定を確認してください",
  upstream: "ただいま接続先が不安定です。少し待って、もう一度お試しください",
  maintenance: "ただいまメンテナンス中です。少し待って、もう一度お試しください",
  timeout: "返事に時間がかかっています。少し待って、もう一度お試しください",
  network: "通信が切れました。接続を確認して、もう一度お試しください",
  unknown: "送信できませんでした。もう一度お試しください",
  interrupted: "前回の返答は中断されました。もう一度送れます。",
} satisfies Record<YuiRequestErrorKind, string>;

function syncComposerHeight(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  const measuredHeight = textarea.scrollHeight > 0
    ? textarea.scrollHeight
    : COMPOSER_SINGLE_LINE_HEIGHT_PX;
  const nextHeight = measuredHeight <= COMPOSER_SINGLE_LINE_HEIGHT_PX
    ? COMPOSER_SINGLE_LINE_HEIGHT_PX
    : Math.min(measuredHeight, COMPOSER_MAX_HEIGHT_PX);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
}

export type ChatProps = {
  bgm?: BgmController;
  taskStatus?: ReactNode;
  localPreview?: boolean;
  renderMessageActions?: (text:string)=>ReactNode;
  renderLifeCard?: (card: import("@yui/domain").LifeCard, messageId:string)=>ReactNode;
  state: Omit<ChatState, "delayedGreetingReplyGroupId">;
  delayedGreetingReplyGroupId: string | null;
  onGreetingRevealed: (replyGroupId: string) => void;
  hydrating: boolean;
  persistenceWarning: boolean | string;
  onRetryPersistence?: () => void;
  persistenceRetrying?: boolean;
  onSend: (text: string) => void;
  onStopGeneration?: () => void;
  generating?: boolean;
  onDraftChange?: (draft: string) => void;
  onRetry: (messageId: string) => void;
  onOpenSettings: () => void;
  menuExpanded?: boolean;
  onAuthenticationRequired?: () => void;
  onCall: () => void;
  onStartDictation?: () => void;
  onSendDictation?: () => void;
  dictationDraft?: { id: number; text: string } | null;
  dictationState?: DictationState;
  dictationError?: string | null;
  dictationDisabled?: boolean;
  callDisabled?: boolean;
  callPreparing?: boolean;
  callError?: string | null;
  conversationGeneration?: number;
  sourceMessageId?: string | null;
  scrollLead?: ReactNode;
  integratedChrome?: boolean;
  suppressComposerAutofocus?: boolean;
  avatar?: ReactNode;
  waitingForSpeech?: boolean;
  spokenStageText?: string;
  avatarControls?: ReactNode;
  onSwipe?: (direction: "previous" | "next") => void;
  returnHomeRequestId?: number;
  openSearchRequestId?: number;
  onSearchRequestHandled?: () => void;
  clearDraftRequestId?: number;
  photoInputEnabled?: boolean;
  photoInputBusy?: boolean;
  onPhotoSelected?: (file: File) => void;
  loadPhotoContent?: (photoId: string, signal: AbortSignal) => Promise<{ objectUrl: string; dispose(): void }>;
  onDeletePhoto?: (photoId: string) => Promise<void> | void;
  photoPreview?: { url: string; byteSize: number; sending?: boolean; retryable?: boolean; saveOnly?: boolean } | null;
  photoStatusMessage?: string | null;
  photoErrorMessage?: string | null;
  onSendPhoto?: () => void;
  onCancelPhoto?: () => void;
  proactiveAction?: Readonly<{
    messageId: string;
    state: "ready" | "processing" | "dismissed" | "deferred" | "unneeded" | "cancelled";
    failed: boolean;
    canCancel: boolean;
    onAction(action: ProactiveUiAction): void;
  }> | null;
  causalCueEnabled?: boolean;
  causalCue?: TalkCausalCue | null;
  visualStyle?: VisualStyle;
};

function causalCueText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cue = value as Record<string, unknown>;
  if (typeof cue.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(cue.requestId)) return null;
  if (cue.phase === "received") return "受け取りました。返事をつくっています";
  if (cue.phase === "waiting") return "ずんだもんが返事をつくっています";
  if (cue.phase === "delivered" && typeof cue.replyGroupId === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(cue.replyGroupId)) {
    return "ずんだもんから返事が届きました";
  }
  return null;
}

function YuiStateCue({ cue }: { cue: TalkCausalCue }) {
  const text = causalCueText(cue);
  const announcement = cue.phase === "received" ? "ずんだもんが返事をつくっています" : text;
  return text ? <li className={cue.phase === "delivered" ? "yui-state-cue" : "typing-indicator"} data-phase={cue.phase} role="status" aria-live="polite" aria-label={announcement ?? undefined}>{cue.phase === "delivered" ? text : <><span className="typing-dot" aria-hidden="true" /><span className="typing-dot" aria-hidden="true" /><span className="typing-dot" aria-hidden="true" /></>}</li> : null;
}

function PhotoTimelineItem({ photoId, caption, createdAt, delivery, loadPhotoContent, onDeletePhoto }: { photoId: string; caption: string; createdAt: string; delivery: "sending" | "sent" | "failed"; loadPhotoContent?: ChatProps["loadPhotoContent"]; onDeletePhoto?: ChatProps["onDeletePhoto"] }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [photoAspectRatio, setPhotoAspectRatio] = useState(1);
  const [unavailable, setUnavailable] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  useEffect(() => {
    if (!loadPhotoContent || delivery !== "sent") return;
    setUnavailable(false);
    setImageUrl(null);
    const abort = new AbortController();
    let active = true;
    let handle: { dispose(): void } | null = null;
    void loadPhotoContent(photoId, abort.signal).then((loaded) => {
      handle = loaded;
      if (!active) { loaded.dispose(); return; }
      setImageUrl(loaded.objectUrl);
    }, () => { if (active) setUnavailable(true); });
    return () => { active = false; abort.abort(); handle?.dispose(); };
  }, [loadPhotoContent, photoId, delivery]);
  const photoActionRef = useRef<HTMLButtonElement>(null);
  const closePhotoActions = () => { setDeleteConfirmationOpen(false); photoActionRef.current?.focus(); };
  const thumbnail = imageUrl && !unavailable
    ? <img src={imageUrl} alt="送信した写真" style={{ width: `min(16rem, 72vw, ${16 * photoAspectRatio}rem)` }} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) setPhotoAspectRatio(image.naturalWidth / image.naturalHeight); }} onError={() => setUnavailable(true)} />
    : <div className="chat-photo-placeholder">{unavailable ? "写真を表示できません" : "写真を読み込んでいます"}</div>;
  return <li className="chat-photo" aria-label={`あなた：写真${caption ? `（${caption}）` : ""}`}>
    {delivery === "sent" ? onDeletePhoto
      ? <button ref={photoActionRef} className="chat-photo-trigger" type="button" aria-label="写真の操作を開く" aria-haspopup="dialog" aria-expanded={deleteConfirmationOpen} onClick={() => { if (deleting) return; setDeleteFailed(false); setDeleteConfirmationOpen((open) => !open); }}>{thumbnail}</button>
      : thumbnail : null}
    {delivery === "failed" || (delivery === "sent" && unavailable) ? <p role="status">{delivery === "failed" ? "写真の送信・保存を確認できません" : "保存済みですが、写真を表示できません"}</p> : null}
    {delivery === "sending" ? <p role="status">写真を送信・保存しています</p> : null}
    {caption ? <p className="chat-photo-caption">{caption}</p> : null}
    <time dateTime={createdAt}>{localTimeLabel(createdAt)}</time>
    {deleteFailed ? <p role="status">写真を削除できませんでした。もう一度お試しください。</p> : null}
    {deleteConfirmationOpen ? <section className="photo-delete-confirmation" role="dialog" aria-label="写真を削除" onKeyDown={(event) => { if (event.key === "Escape" && !deleting) { event.stopPropagation(); closePhotoActions(); } }}>
      <p>この写真を会話から削除します。</p>
      <button type="button" autoFocus disabled={deleting} onClick={closePhotoActions}>やめる</button>
      <button type="button" disabled={deleting} onClick={() => {
        if (!onDeletePhoto || deleting) return;
        setDeleting(true);
        void Promise.resolve(onDeletePhoto(photoId)).then(() => {
          setDeleting(false);
          setDeleteConfirmationOpen(false);
        }, () => {
          setDeleting(false);
          setDeleteConfirmationOpen(false);
          setDeleteFailed(true);
        });
      }}>写真を削除する</button>
    </section> : null}
  </li>;
}

function validLocalDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localDateLabel(value: string): string {
  const date = validLocalDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).formatToParts(date);
  const find = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${find("month")}月${find("day")}日（${find("weekday")}）`;
}

export function localDateKey(value: string): string {
  const date = validLocalDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localTimeLabel(value: string): string {
  const date = validLocalDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function callDuration(card: CallCard): string {
  const milliseconds = Math.max(0, Date.parse(card.endedAt) - Date.parse(card.startedAt));
  return milliseconds < 60_000 ? "1分未満" : `${Math.round(milliseconds / 60_000)}分`;
}

function hasReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type AssistantReplyBubble = Extract<TimelineItem, { type: "message"; role: "assistant" }>;
type ProgrammaticScroll = {
  target: Element;
  block: ScrollLogicalPosition;
  fallbackTimer: number;
};

function isAssistantReplyBubble(item: TimelineItem): item is AssistantReplyBubble {
  return item.type === "message" && item.role === "assistant" && Boolean(item.replyGroupId);
}

function initialVisibleIds(timeline: TimelineItem[], delayedGreetingReplyGroupId: string | null): Set<string> {
  return new Set(timeline
    .filter((item) => !isAssistantReplyBubble(item) || item.replyGroupId !== delayedGreetingReplyGroupId)
    .map((item) => item.id));
}

export function Chat({ bgm, taskStatus, onStopGeneration, generating = false, localPreview = false, waitingForSpeech = false, spokenStageText, avatarControls, avatar, integratedChrome = false, renderLifeCard, renderMessageActions, state, delayedGreetingReplyGroupId, onGreetingRevealed, hydrating, persistenceWarning, onRetryPersistence, persistenceRetrying = false, onSend, onDraftChange, onRetry, onOpenSettings, menuExpanded = false, onAuthenticationRequired, onCall, onStartDictation, onSendDictation, dictationDraft = null, dictationState = "idle", dictationError = null, dictationDisabled = false, callDisabled = false, callPreparing = false, callError = null, conversationGeneration = 0, sourceMessageId = null, scrollLead, suppressComposerAutofocus = false, onSwipe, returnHomeRequestId = 0, openSearchRequestId = 0, onSearchRequestHandled, clearDraftRequestId = 0, photoInputEnabled = false, photoInputBusy = false, onPhotoSelected, loadPhotoContent, onDeletePhoto, photoPreview = null, photoStatusMessage = null, photoErrorMessage = null, onSendPhoto, onCancelPhoto, proactiveAction = null, causalCueEnabled = false, causalCue = null, visualStyle = "yui" }: ChatProps) {
  const [liveChatNotice, setLiveChatNotice] = useState(false);
  const [draft, setDraft] = useState(state.snapshot.draft);
  const [photoChooserOpen, setPhotoChooserOpen] = useState(false);
  const photoPickerRef = useRef<HTMLElement>(null);
  const photoToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!photoChooserOpen) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (photoPickerRef.current?.contains(target) || photoToggleRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      setPhotoChooserOpen(false);
      photoToggleRef.current?.focus();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPhotoChooserOpen(false);
      photoToggleRef.current?.focus();
    };
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [photoChooserOpen]);
  const [composerRestored, setComposerRestored] = useState(false);
  const restoreComposerFocusRef = useRef(false);
  const [visibleIds, setVisibleIds] = useState(() => initialVisibleIds(state.snapshot.timeline, delayedGreetingReplyGroupId));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<number | null>(null);
  const [returnAnchorMessageId, setReturnAnchorMessageId] = useState<string | null>(null);
  const [followState, setFollowState] = useState<ChatFollowState>({ following: true, hasUnreadReply: false, suspendedBySearch: false });
  const [ordinaryReplyPendingGroups, setOrdinaryReplyPendingGroups] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = rootRef.current;
    if (!viewport || !root) return;
    let restingHeight = viewport.height;
    let width = viewport.width;
    const update = () => {
      if (viewport.width > 799) { root.removeAttribute("data-mobile-viewport"); return; }
      if (Math.abs(viewport.width - width) > 50) { restingHeight = viewport.height; width = viewport.width; }
      if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName ?? "") && viewport.height > restingHeight - 100) restingHeight = viewport.height;
      root.dataset.mobileViewport = "true";
      root.style.setProperty("--visible-height", viewport.height + "px");
      root.style.setProperty("--viewport-top", viewport.offsetTop + "px");
      root.style.setProperty("--resting-height", restingHeight + "px");
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => { viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); };
  }, []);
  const headerRef = useRef<HTMLElement>(null);
  const composerLayerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const handledClearDraftRequestRef = useRef(0);
  const suppressComposerAutofocusRef = useRef(suppressComposerAutofocus);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const handledOpenSearchRequestRef = useRef(0);
  const scrollContainerRef = useRef<HTMLElement>(null);
  const endSentinelRef = useRef<HTMLLIElement>(null);
  const messageNodesRef = useRef(new Map<string, HTMLLIElement>());
  const focusedMemorySourceRef = useRef<string | null>(null);
  const programmaticScrollRef = useRef<ProgrammaticScroll | null>(null);
  const searchOpenRef = useRef(searchOpen);
  const searchReturnDistanceRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const composingRef = useRef(false);
  const replyRevealTimersRef = useRef(new Map<string, number[]>());
  const greetingTimersRef = useRef<number[]>([]);
  const greetingGenerationRef = useRef(0);
  const replyRevealGenerationRef = useRef(new Map<string, number>());
  const onGreetingRevealedRef = useRef(onGreetingRevealed);
  const knownReplyGroupsRef = useRef(new Set(state.snapshot.timeline.filter(isAssistantReplyBubble).map((item) => item.replyGroupId)));
  onGreetingRevealedRef.current = onGreetingRevealed;
  suppressComposerAutofocusRef.current = suppressComposerAutofocus;

  useEffect(() => {
    if (clearDraftRequestId === 0 || clearDraftRequestId === handledClearDraftRequestRef.current) return;
    handledClearDraftRequestRef.current = clearDraftRequestId;
    setDraft("");
    onDraftChange?.("");
  }, [clearDraftRequestId, onDraftChange]);
  const hasPending = state.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.delivery === "sending");
  const hasPendingSearch = state.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.delivery === "sending" && shouldUseWebSearch(item.text));
  const causalRequest = causalCue === null ? null : state.snapshot.timeline.find(
    (item): item is Extract<TimelineItem, { type: "message"; role: "user" }> => item.type === "message" && item.role === "user" && item.id === causalCue.requestId,
  ) ?? null;
  const causalCueHasObservedState = causalCue?.phase === "delivered"
    ? causalRequest?.delivery === "sent"
    : causalRequest?.delivery === "sending";
  const visibleCausalCue = causalCueEnabled
    && visualStyle === "yui"
    && causalCue !== null
    && causalCueText(causalCue) !== null
    && causalCueHasObservedState
    && !shouldUseWebSearch(causalRequest?.text ?? "")
    && dictationState === "idle"
    && !callPreparing
      ? causalCue
      : null;
  const pendingCausalCue = visibleCausalCue?.phase === "received" || visibleCausalCue?.phase === "waiting" ? visibleCausalCue : null;
  const delayedGreetingBubbles = state.snapshot.timeline
    .filter((item): item is AssistantReplyBubble => isAssistantReplyBubble(item) && item.replyGroupId === delayedGreetingReplyGroupId)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const delayedGreetingSignature = delayedGreetingBubbles.map((bubble) => bubble.id).join("|");
  const delayedGreetingPending = delayedGreetingReplyGroupId !== null
    && delayedGreetingBubbles.some((bubble) => bubble.sequence === 0 && !visibleIds.has(bubble.id));
  const ordinaryReplyPending = ordinaryReplyPendingGroups.size > 0;
  const showStaticCausalCue = causalCueEnabled
    && visualStyle === "yui"
    && causalCue === null
    && state.snapshot.timeline.length === 0
    && !hydrating
    && state.openingRequestId === null
    && !delayedGreetingPending
    && !ordinaryReplyPending
    && dictationState === "idle"
    && !callPreparing
    && callError === null;
  const dictationBlocked = hydrating || dictationState === "transcribing" || dictationDisabled || (dictationState !== "recording" && (hasPending || Boolean(draft.trim())));
  const photoSelectionAvailable = photoInputEnabled && typeof onPhotoSelected === "function";
  const photoSelectionEnabled = photoSelectionAvailable && !photoInputBusy;
  const composerCollapsed = !followState.following && !searchOpen && !composerRestored
    && draft.length === 0 && !photoPreview && !photoInputBusy && !photoChooserOpen
    && dictationState === "idle" && !callPreparing;
  const composerCollapsedRef = useRef(composerCollapsed);
  composerCollapsedRef.current = composerCollapsed;
  const photoPreviewActionsEnabled = photoPreview !== null && !photoPreview.sending && typeof onSendPhoto === "function" && typeof onCancelPhoto === "function";
  const searchResults = useMemo(
    () => searchChatHistory(state.snapshot.timeline, searchQuery),
    [searchQuery, state.snapshot.timeline],
  );
  const currentSearchResult = searchIndex === null ? null : searchResults[searchIndex] ?? null;

  const scrollBehavior = () => hasReducedMotion() ? "auto" : "smooth";
  const clearProgrammaticScroll = () => {
    const active = programmaticScrollRef.current;
    if (!active) return;
    window.clearTimeout(active.fallbackTimer);
    programmaticScrollRef.current = null;
  };
  const finalizeProgrammaticScroll = () => {
    if (!programmaticScrollRef.current) return;
    clearProgrammaticScroll();
    if (searchOpenRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowState((current) => reduceChatFollow(current, { type: "user-scrolled", distanceFromBottom }));
  };
  const scrollToNode = (node: Element | null, block: ScrollLogicalPosition) => {
    const container = scrollContainerRef.current;
    if (!node || !container) return;
    clearProgrammaticScroll();
    const fallbackTimer = window.setTimeout(() => {
      if (programmaticScrollRef.current?.target === node) finalizeProgrammaticScroll();
    }, 2_000);
    programmaticScrollRef.current = { target: node, block, fallbackTimer };
    // Scroll only the history: scrollIntoView can also pan the iOS page behind the keyboard.
    const target = node.getBoundingClientRect(), viewport = container.getBoundingClientRect();
    const top = block === "end" ? container.scrollHeight - container.clientHeight
      : container.scrollTop + target.top - viewport.top - Math.max(0, (container.clientHeight - target.height) / 2);
    const boundedTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, top));
    if (typeof container.scrollTo === "function") container.scrollTo({ top: boundedTop, behavior: scrollBehavior() });
    else container.scrollTop = boundedTop;
  };
  const scrollToMessage = (messageId: string | null) => scrollToNode(messageId === null ? null : messageNodesRef.current.get(messageId) ?? null, "center");
  const scrollToLatest = () => scrollToNode(endSentinelRef.current, "end");
  const jumpToLatest = () => {
    setComposerRestored(false);
    scrollToLatest();
    setFollowState((current) => reduceChatFollow(current, { type: "jump-to-latest" }));
  };

  const nearestVisibleMessageId = (): string | null => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    let nearest: { id: string; distance: number } | null = null;
    for (const item of state.snapshot.timeline) {
      if (item.type !== "message" || (item.role !== "user" && !visibleIds.has(item.id))) continue;
      const node = messageNodesRef.current.get(item.id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
      const candidate = { id: item.id, distance: Math.abs(rect.top - containerRect.top) };
      if (nearest === null || candidate.distance < nearest.distance) nearest = candidate;
    }
    return nearest?.id ?? null;
  };

  const isRenderedMessage = (item: TimelineItem): item is Extract<TimelineItem, { type: "message" }> => item.type === "message" && (item.role === "user" || visibleIds.has(item.id));

  const programmaticTargetReached = () => {
    const active = programmaticScrollRef.current;
    const container = scrollContainerRef.current;
    if (!active || !container) return false;
    if (active.block === "end") return container.scrollHeight - container.scrollTop - container.clientHeight <= 1;
    const containerRect = container.getBoundingClientRect();
    const targetRect = active.target.getBoundingClientRect();
    return targetRect.top >= containerRect.top && targetRect.bottom <= containerRect.bottom;
  };

  useEffect(() => {
    if (!hydrating && !sourceMessageId && !suppressComposerAutofocusRef.current) composerRef.current?.focus();
  }, [hydrating, sourceMessageId]);

  useEffect(() => {
    if (!sourceMessageId) {
      focusedMemorySourceRef.current = null;
      return;
    }
    if (hydrating || focusedMemorySourceRef.current === sourceMessageId) return;
    const source = messageNodesRef.current.get(sourceMessageId);
    if (!source) return;
    focusedMemorySourceRef.current = sourceMessageId;
    scrollToMessage(sourceMessageId);
    source.focus({ preventScroll: true });
  }, [hydrating, sourceMessageId, state.snapshot.timeline]);

  useLayoutEffect(() => {
    syncComposerHeight(composerRef.current);
    if (!composerCollapsed && restoreComposerFocusRef.current) {
      restoreComposerFocusRef.current = false;
      composerRef.current?.focus({ preventScroll: true });
    }
  }, [draft, dictationState, composerCollapsed]);

  useEffect(() => {
    if (followState.following) setComposerRestored(false);
  }, [followState.following]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    const composerLayer = composerLayerRef.current;
    if (!root || !header || !composerLayer) return;

    const measure = () => {
      const height = composerLayer.getBoundingClientRect().height;
      applyChatOverlayInsets(root, header.getBoundingClientRect().height, height);
      const toolbar = header.querySelector(".chat-header-bar");
      if (toolbar) root.style.setProperty("--avatar-header-height", toolbar.getBoundingClientRect().height + "px");
      // Keep the history's scroll extent stable when only the empty input collapses.
      if (!composerCollapsedRef.current) root.style.setProperty("--chat-timeline-composer-height", `${height}px`);
    };
    let observer: ResizeObserver | null = null;
    let frame: number | null = null;

    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(measure);
      observer.observe(header);
      observer.observe(composerLayer);
      measure();
    } else if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(measure);
    } else {
      measure();
    }

    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    setSearchIndex(selectInitialResult(searchResults, returnAnchorMessageId, state.snapshot.timeline));
  }, [returnAnchorMessageId, searchOpen, searchResults, state.snapshot.timeline]);

  useEffect(() => {
    if (searchOpen && currentSearchResult) scrollToMessage(currentSearchResult.messageId);
  }, [currentSearchResult, searchOpen]);

  const visibleMessageIds = state.snapshot.timeline
    .filter(isRenderedMessage)
    .map((item) => item.id)
    .join("|");

  useEffect(() => {
    if (followState.following) scrollToLatest();
  }, [conversationGeneration, followState.following, hasPending, visibleMessageIds]);

  useEffect(() => {
    if (!hydrating) setDraft(state.snapshot.draft);
  }, [hydrating]);

  useEffect(() => {
    if (!dictationDraft) return;
    updateDraft(dictationDraft.text);
  }, [dictationDraft?.id]);

  useEffect(() => () => {
    for (const timers of replyRevealTimersRef.current.values()) {
      for (const timer of timers) window.clearTimeout(timer);
    }
    replyRevealTimersRef.current.clear();
    replyRevealGenerationRef.current.clear();
    setOrdinaryReplyPendingGroups(new Set());
  }, [conversationGeneration]);

  useEffect(() => {
    const generation = greetingGenerationRef.current + 1;
    greetingGenerationRef.current = generation;
    for (const timer of greetingTimersRef.current) window.clearTimeout(timer);
    greetingTimersRef.current = [];
    if (delayedGreetingReplyGroupId === null) return;

    const greetingBubbles = state.snapshot.timeline
      .filter((item): item is AssistantReplyBubble => isAssistantReplyBubble(item) && item.replyGroupId === delayedGreetingReplyGroupId)
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    setVisibleIds((ids) => {
      const next = new Set(ids);
      for (const bubble of greetingBubbles) next.delete(bubble.id);
      return next;
    });

    const reveal = (sequence: number, complete: boolean) => {
      if (greetingGenerationRef.current !== generation) return;
      const bubble = greetingBubbles.find((item) => item.sequence === sequence);
      if (bubble) {
        setVisibleIds((ids) => new Set(ids).add(bubble.id));
        setFollowState((current) => reduceChatFollow(current, { type: "assistant-bubble-visible" }));
      }
      if (complete) onGreetingRevealedRef.current(delayedGreetingReplyGroupId);
    };
    greetingTimersRef.current = [
      window.setTimeout(() => reveal(0, false), 1_800),
      window.setTimeout(() => reveal(1, true), 2_400),
    ];

    return () => {
      if (greetingGenerationRef.current === generation) greetingGenerationRef.current += 1;
      for (const timer of greetingTimersRef.current) window.clearTimeout(timer);
      greetingTimersRef.current = [];
    };
  }, [conversationGeneration, delayedGreetingReplyGroupId, delayedGreetingSignature]);

  useEffect(() => () => {
    const active = programmaticScrollRef.current;
    if (active) clearProgrammaticScroll();
  }, []);

  useEffect(() => {
    const newBubbles = state.snapshot.timeline.filter(isAssistantReplyBubble).filter((item) => !knownReplyGroupsRef.current.has(item.replyGroupId));
    for (const bubble of newBubbles) knownReplyGroupsRef.current.add(bubble.replyGroupId);
    const freshBubbles = newBubbles.filter((item) => item.replyGroupId !== delayedGreetingReplyGroupId);
    if (freshBubbles.length === 0) return;
    const freshReplyGroups = new Map<string, AssistantReplyBubble[]>();
    for (const bubble of freshBubbles) {
      if (!bubble.replyGroupId) continue;
      const group = freshReplyGroups.get(bubble.replyGroupId) ?? [];
      group.push(bubble);
      freshReplyGroups.set(bubble.replyGroupId, group);
    }
    if (hasReducedMotion()) {
      setVisibleIds((ids) => {
        const next = new Set(ids);
        for (const bubble of freshBubbles) next.add(bubble.id);
        return next;
      });
      setFollowState((current) => freshBubbles.reduce(
        (next) => reduceChatFollow(next, { type: "assistant-bubble-visible" }),
        current,
      ));
      return;
    }
    for (const [replyGroupId, bubbles] of freshReplyGroups) {
      const generation = (replyRevealGenerationRef.current.get(replyGroupId) ?? 0) + 1;
      replyRevealGenerationRef.current.set(replyGroupId, generation);
      const ordered = [...bubbles].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
      setOrdinaryReplyPendingGroups((groups) => new Set(groups).add(replyGroupId));
      const timers: number[] = [];
      for (const [index, bubble] of ordered.entries()) {
        const delay = REPLY_FIRST_BUBBLE_DELAY_MS + index * REPLY_BUBBLE_INTERVAL_MS;
        const timer = window.setTimeout(() => {
          if (replyRevealGenerationRef.current.get(replyGroupId) !== generation) return;
          setVisibleIds((ids) => new Set(ids).add(bubble.id));
          setFollowState((current) => reduceChatFollow(current, { type: "assistant-bubble-visible" }));
          if (index === ordered.length - 1) {
            replyRevealTimersRef.current.delete(replyGroupId);
            setOrdinaryReplyPendingGroups((groups) => {
              const next = new Set(groups);
              next.delete(replyGroupId);
              return next;
            });
          }
        }, delay);
        timers.push(timer);
      }
      replyRevealTimersRef.current.set(replyGroupId, timers);
    }
  }, [delayedGreetingReplyGroupId, state.snapshot.timeline]);

  const updateDraft = (value: string) => {
    setDraft(value);
    onDraftChange?.(value);
  };

  const submitDraft = () => {
    if (generating) return;
    if (dictationState === "recording") {
      onSendDictation?.();
      return;
    }
    if (photoPreview) {
      if (!photoPreviewActionsEnabled || hasPending || hydrating || submittingRef.current || composingRef.current) return;
      submittingRef.current = true;
      onSendPhoto?.();
      queueMicrotask(() => { submittingRef.current = false; });
      return;
    }
    if (!draft.trim() || hasPending || hydrating || submittingRef.current || composingRef.current) return;
    submittingRef.current = true;
    const text = draft;
    updateDraft("");
    onSend(text);
    queueMicrotask(() => { submittingRef.current = false; });
  };

  const openSearch = () => {
    setDesktopLogOpen(true);
    const anchorMessageId = nearestVisibleMessageId();
    const container = scrollContainerRef.current;
    searchOpenRef.current = true;
    searchReturnDistanceRef.current = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : null;
    setReturnAnchorMessageId(anchorMessageId);
    setSearchQuery("");
    setSearchIndex(null);
    setSearchOpen(true);
    setFollowState((current) => reduceChatFollow(current, { type: "search-opened" }));
  };

  useEffect(() => {
    if (openSearchRequestId <= 0 || handledOpenSearchRequestRef.current === openSearchRequestId) return;
    handledOpenSearchRequestRef.current = openSearchRequestId;
    openSearch();
    onSearchRequestHandled?.();
  }, [openSearchRequestId, onSearchRequestHandled]);

  const closeSearch = () => {
    const container = scrollContainerRef.current;
    const distanceFromBottom = searchReturnDistanceRef.current ?? (container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : 0);
    searchReturnDistanceRef.current = null;
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(null);
    setFollowState((current) => reduceChatFollow(current, { type: "search-closed", distanceFromBottom }));
    scrollToMessage(returnAnchorMessageId);
    searchToggleRef.current?.focus({ preventScroll: true });
  };

  const onScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (searchOpenRef.current) return;
    if (programmaticScrollRef.current) {
      if (programmaticTargetReached()) finalizeProgrammaticScroll();
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowState((current) => reduceChatFollow(current, { type: "user-scrolled", distanceFromBottom }));
  };

  const moveSearchResult = (offset: -1 | 1) => {
    setSearchIndex((current) => {
      if (searchResults.length === 0) return null;
      const fallback = selectInitialResult(searchResults, returnAnchorMessageId, state.snapshot.timeline) ?? 0;
      return Math.max(0, Math.min(searchResults.length - 1, (current ?? fallback) + offset));
    });
  };

  const [desktopLogOpen, setDesktopLogOpen] = useState(false);
  useLayoutEffect(() => {
    if (sourceMessageId) setDesktopLogOpen(true);
  }, [sourceMessageId]);
  useLayoutEffect(() => {
    if (!returnHomeRequestId) return;
    setDesktopLogOpen(false);
    if (searchOpenRef.current) closeSearch();
  }, [returnHomeRequestId]);
  useLayoutEffect(() => {
    if (!desktopLogOpen || searchOpen || sourceMessageId || hydrating) return;
    // Set the initial viewport before paint; never animate through the backlog.
    clearProgrammaticScroll();
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    setComposerRestored(false);
    setFollowState(current => current.following && !current.hasUnreadReply && !current.suspendedBySearch
      ? current : reduceChatFollow(current, { type: "jump-to-latest" }));
  }, [desktopLogOpen, hydrating]);

  const stageText = spokenStageText ?? stageDialogue(state.snapshot.timeline.filter(item => item.type !== "message" || isRenderedMessage(item)));
  const swipe = useIntegratedSwipe(onSwipe);
  const stageThinking = hasPending || waitingForSpeech || (spokenStageText === undefined && (ordinaryReplyPending || delayedGreetingPending));
  const chatHeader = <header ref={headerRef} className="chat-header">
    <div className="chat-header-bar">
      <div className="header-leading-actions">
      </div>
      <div className="header-trailing-actions">
        <button className="desktop-log-toggle header-action" type="button" aria-expanded={desktopLogOpen} aria-controls="desktop-conversation-log" onClick={() => setDesktopLogOpen(open => !open)} aria-label={desktopLogOpen ? "トークを閉じる" : "トークを開く"}><ChatCircleText size={22} weight={desktopLogOpen ? "fill" : "regular"} aria-hidden="true"/></button>
        <button className="call-action" type="button" aria-label={callPreparing ? "通話を準備しています" : "ライブチャットを開始"} title="ライブチャット" aria-busy={callPreparing} onClick={() => { if (localPreview) setLiveChatNotice(!liveChatNotice); else onCall?.(); }} disabled={!localPreview && (callPreparing || callDisabled)}><Phone aria-hidden="true" size={23} /></button>
        {avatarControls}
        {bgm ? <BgmHeader controller={bgm} /> : null}
        <button className="header-action menu-action" type="button" aria-label={(scrollLead || integratedChrome) ? "メニューを開く" : "設定を開く"} aria-expanded={menuExpanded} onClick={onOpenSettings}>{(scrollLead || integratedChrome) ? <HamburgerMenuIcon aria-hidden="true" /> : <GearSix aria-hidden="true" size={24} />}</button>
        {localPreview && liveChatNotice ? <span className="live-chat-notice" role="status">ライブチャットはまだ未接続です</span> : null}
      </div>
    </div>
    {callPreparing ? <div className="call-feedback call-preparing" role="status" aria-label="ずんだもんとの通話を接続中"><span className="call-preparing-dot" aria-hidden="true" /><p>ずんだもんと接続しています</p></div>
      : callError ? <div className="call-feedback call-error" role="alert" aria-label="通話の準備"><p>{callError}</p><button type="button" aria-label="通話をもう一度試す" onClick={onCall}>もう一度試す</button></div>
        : null}
  </header>;
  return (
    <main ref={rootRef} className={`chat-screen chat-refresh${desktopLogOpen ? "" : " desktop-log-closed"} avatar-conversation${searchOpen ? " is-history-searching" : ""}`} data-integrated-ui={(scrollLead || integratedChrome) ? "true" : undefined} aria-label={(scrollLead || integratedChrome) ? "ずんだもんとの継続トーク" : undefined} {...swipe}>
      {chatHeader}
      {avatar}
      <section className="desktop-stage-dialogue" aria-label="ずんだもんの今のセリフ"><StageSpeech thinking={stageThinking} text={stageText} links={stageLinks(state.snapshot.timeline.filter(item => item.type !== "message" || isRenderedMessage(item)))} /></section>

      <div className={`chat-history-shell${searchOpen ? " is-searching" : ""}`} id="desktop-conversation-log">
        <div className="desktop-log-heading">
          <h2 className="desktop-log-title">トーク</h2>
          {searchOpen ? <output className="talk-search-count" aria-live="polite">{currentSearchResult === null ? `0 / ${searchResults.length}` : `${searchIndex! + 1} / ${searchResults.length}`}</output> : null}
          <button ref={searchToggleRef} className="talk-search-toggle" type="button" aria-label={searchOpen ? "検索を閉じる" : "履歴を検索"} aria-expanded={searchOpen} aria-controls="talk-history-search" onClick={searchOpen ? closeSearch : openSearch}>
            {searchOpen ? <X aria-hidden="true" size={22} /> : <MagnifyingGlass aria-hidden="true" size={22} />}
          </button>
        </div>
    <div className="chat-search-slot">
      {searchOpen ? <section id="talk-history-search" className="chat-search" aria-label="履歴検索" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } }}>
        <input ref={searchInputRef} type="search" role="searchbox" placeholder="トークを検索" aria-label="チャット履歴を検索" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        <button type="button" aria-label="前の検索結果" onClick={() => moveSearchResult(-1)} disabled={searchResults.length === 0}><ArrowUp aria-hidden="true" size={20} /></button>
        <button type="button" aria-label="次の検索結果" onClick={() => moveSearchResult(1)} disabled={searchResults.length === 0}><ArrowDown aria-hidden="true" size={20} /></button>
      </section> : null}
    </div>
        <section ref={scrollContainerRef} className="chat-scroll-area" data-testid="chat-scroll-area" onScroll={onScroll} onScrollEnd={finalizeProgrammaticScroll}>
          <ol className="chat-timeline" aria-live={causalCueEnabled && visualStyle === "yui" ? undefined : "polite"} aria-label="ずんだもんとの会話">
            {state.snapshot.timeline.reduce<ReactNode[]>((items, item, index, timeline) => {
              if (item.type === "message" && !isRenderedMessage(item)) return items;
              const timestamp = item.type === "call" ? item.startedAt : item.createdAt;
              const dateKey = localDateKey(timestamp);
              const previous = timeline.slice(0, index).reverse().find(candidate =>
                (candidate.type !== "message" || isRenderedMessage(candidate)) &&
                Boolean(localDateKey(candidate.type === "call" ? candidate.startedAt : candidate.createdAt)));
              const previousTimestamp = previous && (previous.type === "call" ? previous.startedAt : previous.createdAt);
              if (dateKey && (!previousTimestamp || localDateKey(previousTimestamp) !== dateKey)) items.push(<li className="chat-date-divider" key={`${item.id}:date`}>{localDateLabel(timestamp)}</li>);
              if (item.type === "call") { items.push(<li className="chat-call-card" key={item.id}>ずんだもんと{callDuration(item)}話しました</li>); return items; }
              if (item.type === "photo") { items.push(<PhotoTimelineItem key={item.id} photoId={item.photoId} caption={item.caption} createdAt={item.createdAt} delivery={item.delivery} loadPhotoContent={loadPhotoContent} onDeletePhoto={onDeletePhoto} />); return items; }
              if (!isRenderedMessage(item)) return items;
              const time = localTimeLabel(item.createdAt);
              const speaker = item.role === "assistant" ? "ずんだもん" : "あなた";
              const bubble = <p className="chat-message-bubble">{item.text}</p>;
              const timeElement = time ? <time className="chat-message-time" dateTime={item.createdAt}>{time}</time> : null;
              const search = item.role === "assistant" ? item.search : undefined;
              const searchDetails = search
                ? <aside className={`web-search-details is-${search.status}`} aria-label="Web検索の結果">
                    <strong>{search.status === "completed" ? "検索済み" : "検索結果を取得できませんでした"}</strong>
                    {search.status === "completed" ? <>
                      <time className="web-search-checked-at" dateTime={search.searchedAt}>確認 {localTimeLabel(search.searchedAt)}</time>
                      <div className="web-search-evidence">
                        {search.evidence.facts.map((fact) => {
                          const source = search.sources.find((candidate) => candidate.url === fact.sourceUrl);
                          return source ? <div className="web-search-fact" key={`${fact.sourceUrl}:${fact.text}`}><strong>事実</strong><span>{fact.text}</span><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></div> : null;
                        })}
                        {search.evidence.inference ? <div className="web-search-fact"><strong>考えられること</strong><span>{search.evidence.inference}</span></div> : null}
                        {search.evidence.suggestion ? <div className="web-search-fact"><strong>ずんだもんからの提案</strong><span>{search.evidence.suggestion}</span></div> : null}
                      </div>
                    </> : null}
                  </aside>
                : null;
              const failureKind = state.failureByMessageId?.[item.id] ?? "unknown";
              const failureAction = failureKind === "profile-required"
                ? <button type="button" className="retry-action" onClick={onOpenSettings}>設定を開く</button>
                : failureKind === "authentication"
                  ? <button type="button" className="retry-action" disabled={!onAuthenticationRequired} onClick={onAuthenticationRequired}>ログイン画面に戻る</button>
                : <button type="button" className="retry-action" onClick={() => onRetry(item.id)}>もう一度送る</button>;
              const proactiveControls = proactiveAction?.messageId === item.id ? <div className="proactive-message-actions">
                {proactiveAction.state === "ready" || proactiveAction.state === "processing" ? <>
                  <button type="button" disabled={proactiveAction.state === "processing"} onClick={() => proactiveAction.onAction("dismiss")}>閉じる</button>
                  <button type="button" disabled={proactiveAction.state === "processing"} onClick={() => proactiveAction.onAction("later")}>あとで</button>
                  <button type="button" disabled={proactiveAction.state === "processing"} onClick={() => proactiveAction.onAction("unneeded")}>不要</button>
                  {proactiveAction.canCancel ? <button type="button" disabled={proactiveAction.state === "processing"} onClick={() => proactiveAction.onAction("cancel")}>リマインドを取り消す</button> : null}
                </> : <p role="status">{proactiveAction.state === "deferred" ? "次に開いた時まで控えます" : proactiveAction.state === "cancelled" ? "リマインドを取り消しました" : proactiveAction.state === "unneeded" ? "不要として止めました" : "閉じました"}</p>}
                {proactiveAction.failed ? <p role="status">操作を反映できませんでした。もう一度お試しください。</p> : null}
              </div> : null;
              const deliveredPrismEcho = visibleCausalCue?.phase === "delivered" && item.role === "assistant" && item.replyGroupId === visibleCausalCue.replyGroupId && item.sequence === 0;
              if (deliveredPrismEcho) {
                items.push(<YuiStateCue key="yui-causal-status" cue={visibleCausalCue} />);
              }
              items.push(<li ref={(node) => { if (node) messageNodesRef.current.set(item.id, node); else messageNodesRef.current.delete(item.id); }} data-testid={`message-${item.id}`} data-prism-echo={deliveredPrismEcho ? "delivered" : undefined} tabIndex={sourceMessageId === item.id ? -1 : undefined} aria-label={`${speaker}：${item.text}${time ? `（${time}）` : ""}`} className={`chat-message is-${item.role}${currentSearchResult?.messageId === item.id ? " is-search-match" : ""}${sourceMessageId === item.id ? " is-memory-source" : ""}`} key={item.id}><div className="chat-message-row">{item.role === "assistant" ? <>{bubble}{timeElement}</> : <>{timeElement}{bubble}</>}</div>{searchDetails}{item.role === "assistant" && item.lifeCard ? renderLifeCard?.(item.lifeCard,item.id) : null}{item.role === "assistant" ? renderMessageActions?.(item.text) : null}{proactiveControls}{item.role === "user" && item.delivery === "failed" ? <div className="chat-failure"><span className="chat-failure-message" role="status">{chatFailureMessage[failureKind]}</span>{failureAction}</div> : null}</li>);
              return items;
            }, []).concat([
              showStaticCausalCue ? <li className="yui-state-cue is-static" key="yui-causal-static">ここから、話を受け取る</li> : null,
              pendingCausalCue ? <YuiStateCue key="yui-causal-status" cue={pendingCausalCue} /> : hasPending || delayedGreetingPending || ordinaryReplyPending ? <li className="typing-indicator" role="status" aria-label={hasPendingSearch ? "検索中" : "ずんだもんが入力中"} key="typing-indicator">{hasPendingSearch ? <span className="typing-label">検索中</span> : <><span className="typing-dot" aria-hidden="true" /><span className="typing-dot" aria-hidden="true" /><span className="typing-dot" aria-hidden="true" /></>}</li> : null,
              <li className="chat-end-sentinel" aria-hidden="true" ref={endSentinelRef} key="chat-end-sentinel" />,
            ])}
          </ol>
        </section>

        {!followState.following && !followState.suspendedBySearch ? <button type="button" className="latest-chat-action" data-testid="talk-jump-to-latest" aria-label="最新のメッセージへ移動" onClick={jumpToLatest}><ArrowDown aria-hidden="true" size={22} weight="bold" /></button> : null}
      </div>

      <div ref={composerLayerRef} className={`chat-bottom-stack${composerCollapsed ? " is-slid-away" : ""}${(scrollLead || integratedChrome) ? " is-integrated" : ""}${!scrollLead ? " is-talk-only" : ""}`}>
        {taskStatus}
        <form className="chat-composer" onPaste={(event) => {
          if (!photoSelectionEnabled || photoPreview) return;
          const image = Array.from(event.clipboardData.items).find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
          if (image) { event.preventDefault(); onPhotoSelected?.(image); }
        }} onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
          {persistenceWarning ? <div className="persistence-warning"><span role="status">{typeof persistenceWarning === "string" ? persistenceWarning : "この端末には履歴を保存できません"}</span>{onRetryPersistence ? <button type="button" onClick={onRetryPersistence} disabled={persistenceRetrying}>{persistenceRetrying ? "保存中…" : "保存を再試行"}</button> : null}</div> : null}
          {photoErrorMessage ? <p className="photo-presentation-error" role="alert">{photoErrorMessage}</p> : null}
          {photoStatusMessage ? <p className="photo-presentation-progress" role="status">{photoStatusMessage}</p> : null}
          {dictationError ? <p className="dictation-error" role="status">{dictationError}<button type="button" onClick={onStartDictation} disabled={localPreview || dictationBlocked}>もう一度試す</button></p> : null}
          <div className={`composer-shell${photoPreview ? " has-photo" : ""}`} data-empty={draft.length === 0} data-prism-echo={pendingCausalCue?.phase}>
            {photoPreview ? <div className="composer-photo-attachment">
              <img src={photoPreview.url} alt="送信前の写真" />
              <button type="button" aria-label="写真を取り消す" onClick={onCancelPhoto} disabled={!photoPreviewActionsEnabled}><X aria-hidden="true" size={16} /></button>
              {!photoPreview.sending && photoPreview.retryable ? <span role="status">{photoPreview.saveOnly ? "保存を再試行してください" : "送信を再試行してください"}</span> : null}
            </div> : null}
            {dictationState === "recording" ? <span className="recording-indicator" role="status" aria-label="録音中"><Waveform aria-hidden="true" size={26} weight="bold" />録音中…</span> : null}
            {dictationState === "transcribing" ? <span className="dictation-progress" role="status">文字にしています…</span> : null}

            <textarea ref={composerRef} id="yui-composer" rows={1} aria-label="メッセージ" placeholder={dictationState === "recording" || dictationState === "transcribing" ? "" : `${ZUNDAMON_CHARACTER.displayName}に話す`} value={draft} disabled={hydrating || dictationState === "recording"} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
              // keyCode 229 also protects Safari's IME confirmation Enter.
              if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
              const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
                || window.matchMedia?.("(pointer: coarse)").matches;
              if (mobile) return;
              event.preventDefault();
              submitDraft();
            }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} />
            <div className="composer-actions-row">
              {photoSelectionEnabled ? <>
                <input ref={photoInputRef} className="photo-file-input" type="file" aria-label="写真を選ぶ" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  setPhotoChooserOpen(false);
                  if (file) onPhotoSelected?.(file);
                }} />
                <input ref={cameraInputRef} className="photo-file-input" type="file" aria-label="カメラで撮る" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  setPhotoChooserOpen(false);
                  if (file) onPhotoSelected?.(file);
                }} />
                {photoChooserOpen ? <section ref={photoPickerRef} className="photo-picker" role="dialog" aria-label="写真を追加">
                  <button type="button" onClick={() => photoInputRef.current?.click()}><Images aria-hidden="true" size={24} /><span>写真</span></button>
                  <button type="button" onClick={() => cameraInputRef.current?.click()}><Camera aria-hidden="true" size={24} /><span>カメラ</span></button>
                </section> : null}
              </> : null}
              <button ref={photoToggleRef} className="attach-action" type="button" aria-expanded={photoChooserOpen} aria-haspopup="dialog" aria-label={photoSelectionAvailable ? "写真を追加" : "追加機能は現在利用できません"} disabled={!photoSelectionEnabled} onClick={() => setPhotoChooserOpen(open => !open)}>{(scrollLead || integratedChrome) ? <PlusIcon aria-hidden="true" /> : <Plus aria-hidden="true" size={20} />}</button>
              <div className="composer-actions"><button className="microphone-action" type="button" aria-label={dictationState === "recording" ? "音声入力を停止" : "音声入力を開始"} onClick={onStartDictation} disabled={localPreview || dictationBlocked}>{dictationState === "recording" ? <Stop aria-hidden="true" size={20} weight="fill" /> : <Microphone aria-hidden="true" size={24} />}</button>{onStopGeneration && (generating || hasPending) ? <button className="send-action" data-testid="composer-stop" type="button" onClick={onStopGeneration} aria-label="生成を停止" title="生成を停止"><Stop size={22} weight="fill" aria-hidden="true" /></button> : <button className="send-action" data-testid="composer-send-prism" type="submit" disabled={hydrating || hasPending || (photoPreview ? !photoPreviewActionsEnabled : (dictationState !== "recording" && !draft.trim()))} aria-label={dictationState === "recording" ? "録音を送信" : hasPending ? "送信中" : "メッセージを送信"}><ArrowUp aria-hidden="true" size={22} weight="bold" /></button>}</div>
            </div>
          </div>
        </form>
        {scrollLead}
      </div>
    </main>
  );
}
