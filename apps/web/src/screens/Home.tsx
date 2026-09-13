import type { GoogleSourceChoice, GoogleSourceChoiceStore } from "../google-source-choice";
import { CalendarBlank, ChatCircle, CheckSquare, MapPin, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { GooglePreviewResult, GooglePreviewService, GoogleSourceListResult } from "@yui/domain";
import type { HomeManagementView } from "../home-management";
import { useIntegratedSwipe } from "../integrated-swipe";
import { createHomeViewModel, type HomeViewModel, type IntegratedSwipeDirection, type YuiPortrait } from "../integrated-ui";
import type { VisualStyle } from "../visual-style";

type HomeProps = {
  header?: ReactNode;
  navigation: ReactNode;
  model: HomeViewModel;
  portrait?: YuiPortrait;
  onNavigate?: (direction: IntegratedSwipeDirection) => void;
  onStartConversation?: (draft: string) => void;
  onOpenHomeManagement?: (view: HomeManagementView) => void;
  visualStyle?: VisualStyle;
  onPreviewGoogleService?: (service: GooglePreviewService, signal?: AbortSignal, sourceId?: string) => Promise<GooglePreviewResult>;
  onListGoogleSources?: (service: GooglePreviewService, signal?: AbortSignal) => Promise<GoogleSourceListResult>;
  googleSourceChoices?: GoogleSourceChoiceStore;
};

type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; value: GooglePreviewResult }
  | { state: "error" };

const EMPTY_PREVIEW: PreviewState = { state: "idle" };
const GOOGLE_PREVIEW_TIMEOUT_MS = 15_000;

function todayLabel(): string {
  return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
}

export function Home({ header, navigation, model, portrait, onNavigate, onStartConversation, onOpenHomeManagement, visualStyle = "yui", onPreviewGoogleService, onListGoogleSources, googleSourceChoices }: HomeProps): ReactElement {
  const home = createHomeViewModel(model);
  const [imageFailed, setImageFailed] = useState(false);
  const [sourceChoices, setSourceChoices] = useState<Record<GooglePreviewService, GoogleSourceChoice | null>>(() => ({calendar:googleSourceChoices?.get("calendar") ?? null,tasks:googleSourceChoices?.get("tasks") ?? null}));
  const [previews, setPreviews] = useState<Record<GooglePreviewService, PreviewState>>({ calendar: EMPTY_PREVIEW, tasks: EMPTY_PREVIEW });
  const generation = useRef<Record<GooglePreviewService, number>>({ calendar: 0, tasks: 0 });
  const previewInFlight = useRef<Record<GooglePreviewService, boolean>>({ calendar: false, tasks: false });
  const previewAbort = useRef<Record<GooglePreviewService, AbortController | null>>({ calendar: null, tasks: null });
  const swipe = useIntegratedSwipe(onNavigate);
  useEffect(() => { setImageFailed(false); }, [portrait?.src]);
  const calendarVisible = home.sections.some((section) => section.kind === "calendar");
  const tasksVisible = home.sections.some((section) => section.kind === "tasks");
  useEffect(() => {
    setPreviews((current) => ({
      calendar: calendarVisible ? current.calendar : EMPTY_PREVIEW,
      tasks: tasksVisible ? current.tasks : EMPTY_PREVIEW,
    }));
    if (!calendarVisible) {
      googleSourceChoices?.set("calendar", null);
      setSourceChoices((current) => ({...current,calendar:null}));
      previewAbort.current.calendar?.abort();
      previewAbort.current.calendar = null;
      generation.current.calendar += 1;
      previewInFlight.current.calendar = false;
    }
    if (!tasksVisible) {
      googleSourceChoices?.set("tasks", null);
      setSourceChoices((current) => ({...current,tasks:null}));
      previewAbort.current.tasks?.abort();
      previewAbort.current.tasks = null;
      generation.current.tasks += 1;
      previewInFlight.current.tasks = false;
    }
  }, [calendarVisible, tasksVisible, googleSourceChoices]);
  useEffect(() => () => {
    previewAbort.current.calendar?.abort();
    previewAbort.current.tasks?.abort();
    previewAbort.current.calendar = null;
    previewAbort.current.tasks = null;
    generation.current.calendar += 1;
    generation.current.tasks += 1;
    previewInFlight.current.calendar = false;
    previewInFlight.current.tasks = false;
  }, []);

  const loadPreview = (service: GooglePreviewService) => {
    if (!onPreviewGoogleService || previewInFlight.current[service]) return;
    previewInFlight.current[service] = true;
    const controller = new AbortController();
    previewAbort.current[service]?.abort();
    previewAbort.current[service] = controller;
    const currentGeneration = generation.current[service] + 1;
    generation.current[service] = currentGeneration;
    setPreviews((current) => ({ ...current, [service]: { state: "loading" } }));
    const timeout = setTimeout(() => {
      if (generation.current[service] !== currentGeneration) return;
      controller.abort();
      if (previewAbort.current[service] === controller) previewAbort.current[service] = null;
      generation.current[service] += 1;
      previewInFlight.current[service] = false;
      setPreviews((current) => ({ ...current, [service]: { state: "error" } }));
    }, GOOGLE_PREVIEW_TIMEOUT_MS);
    const selectedId = sourceChoices[service]?.id;
    const request = selectedId ? onPreviewGoogleService(service, controller.signal, selectedId) : onPreviewGoogleService(service, controller.signal);
    void request.then((value) => {
      clearTimeout(timeout);
      if (generation.current[service] !== currentGeneration) return;
      if (previewAbort.current[service] === controller) previewAbort.current[service] = null;
      previewInFlight.current[service] = false;
      if (value.service !== service) {
        setPreviews((current) => ({ ...current, [service]: { state: "error" } }));
        return;
      }
      setPreviews((current) => ({ ...current, [service]: { state: "ready", value } }));
    }, () => {
      clearTimeout(timeout);
      if (generation.current[service] !== currentGeneration) return;
      if (previewAbort.current[service] === controller) previewAbort.current[service] = null;
      previewInFlight.current[service] = false;
      setPreviews((current) => ({ ...current, [service]: { state: "error" } }));
    });
  };

  const chooseSource = (service: GooglePreviewService, choice: GoogleSourceChoice | null) => {
    previewAbort.current[service]?.abort();
    previewAbort.current[service] = null;
    generation.current[service] += 1;
    previewInFlight.current[service] = false;
    setPreviews((current) => ({...current,[service]:EMPTY_PREVIEW}));
    googleSourceChoices?.set(service, choice);
    setSourceChoices((current) => ({...current,[service]:choice}));
  };

  return <main className="integrated-page integrated-shell home-screen" {...swipe}>
    {header}
    <div className="integrated-page-scroll">
    <h1 className="sr-only">ホーム</h1>
    <section className="home-intro" aria-label="ずんだもんからのひとこと">
      <div className="yui-portrait-container" aria-label="SDずんだもんの表示枠">
        {portrait && !imageFailed ? <img className="yui-portrait" src={portrait.src} alt={portrait.alt} onError={() => setImageFailed(true)} /> : <p className="yui-portrait-failure">ずんだもんの画像を表示できません</p>}
      </div>
      <div className="yui-speech-bubble">無理しすぎず、今日もぼちぼちいこう</div>
    </section>
    <time className="home-date" dateTime={new Date().toISOString()}>{todayLabel()}</time>
    {home.sections.map((section, index) => {
      const headingId = `home-section-${index}`;
      const googleService = section.kind === "calendar" || section.kind === "tasks" ? section.kind : null;
      return <section className="home-section" aria-labelledby={headingId} key={section.id}>
        <h1 id={headingId}>{section.label}</h1>
        {section.state === "unconfigured" ? <p>天気はまだ表示していません。地域を決めると、ここに出せます。</p> : null}
        {section.kind === "weather"
          ? <button type="button" className="home-row-action" onClick={() => onOpenHomeManagement ? onOpenHomeManagement("weather") : onStartConversation?.("天気の地域を設定したい") }><MapPin aria-hidden="true" size={18} />天気の地域を設定</button>
          : <>
            <div className="home-service-row"><span className="home-service-copy">{section.kind === "calendar" ? <CalendarBlank aria-hidden="true" size={20} /> : <CheckSquare aria-hidden="true" size={20} />}<span>{section.label}</span></span><button type="button" className="home-context-action" data-home-conversation-action aria-label={`${section.label}についてずんだもんに話す`} onClick={() => onStartConversation?.(`${section.label}について話したい`)}><ChatCircle aria-hidden="true" size={20} /></button></div>
            {onListGoogleSources && googleService ? <GoogleSourcePicker service={googleService} choice={sourceChoices[googleService]} onSources={onListGoogleSources} onChoose={(choice) => chooseSource(googleService, choice)} onConnections={() => onOpenHomeManagement?.("connections")} /> : null}
            {onPreviewGoogleService && googleService ? <GooglePreviewPanel service={googleService} label={section.label} state={previews[googleService]} onLoad={() => loadPreview(googleService)} /> : null}
          </>}
      </section>;
    })}
    <section className="home-section" aria-labelledby="services-heading">
      <h1 id="services-heading">接続サービス</h1>
      {home.shellState.state === "off" && visualStyle === "yui" ? <p>接続していない情報は、ずんだもんは取りに行きません。</p> : null}
      {home.shellState.state === "empty" ? <p>確認しましたが、いま表示できる情報はありません。</p> : null}
      {home.shellState.state === "failure" ? <p>いまは情報を表示できません。トークはそのまま使えます。</p> : null}
      <button type="button" className="home-add-service" onClick={() => onOpenHomeManagement ? onOpenHomeManagement("connections") : onStartConversation?.("接続サービスを追加したい") }><Plus aria-hidden="true" size={18} />接続サービスを追加</button>
    </section>
    <button type="button" className="home-management-link" onClick={() => onOpenHomeManagement?.("home")}>ホームを編集</button>
    </div>
    {navigation}
  </main>;
}

function GooglePreviewPanel({ service, label, state, onLoad }: {
  service: GooglePreviewService;
  label: string;
  state: PreviewState;
  onLoad: () => void;
}): ReactElement {
  const actionLabel = state.state === "error" ? `${label}の内容を再試行` : `${label}の内容を見る`;
  return <div className="home-google-preview">
    <button type="button" className="home-row-action" disabled={state.state === "loading"} onClick={onLoad}>
      {state.state === "loading" ? `${label}を確認しています` : actionLabel}
    </button>
    {state.state === "loading" ? <p role="status">{label}を確認しています</p> : null}
    {state.state === "error" ? <p role="alert">内容を確認できませんでした。時間をおいてもう一度お試しください。</p> : null}
    {state.state === "ready" ? <><p className="home-google-checked">{new Intl.DateTimeFormat("ja-JP", {hour:"2-digit",minute:"2-digit"}).format(new Date(state.value.checkedAt))} 更新・{service === "calendar" ? "直近3件まで" : "未完了5件まで"}</p><GooglePreviewItems service={service} value={state.value} /></> : null}
  </div>;
}

function GooglePreviewItems({ service, value }: { service: GooglePreviewService; value: GooglePreviewResult }): ReactElement {
  if (value.service !== service) return <p role="alert">Googleの内容を表示できませんでした</p>;
  if (value.items.length === 0) return <p role="status">{service === "calendar" ? "表示できる予定はありません" : "表示できるタスクはありません"}</p>;
  return <ul className="home-preview-list" aria-label={service === "calendar" ? "予定の内容" : "タスクの内容"}>
    {value.service === "calendar"
      ? value.items.map((item, index) => <li key={`${item.start.value}:${index}`}><span>{item.calendar&&<small>{item.calendar.title} · </small>}{item.title}</span><time dateTime={item.start.value}>{formatCalendarStart(item.start)}</time></li>)
      : value.items.map((item, index) => <li key={`${item.due ?? "none"}:${index}`}><span>{item.title}</span>{item.due ? <time dateTime={item.due}>期限: {formatDateOnly(item.due)}</time> : null}</li>)}
  </ul>;
}

function formatCalendarStart(start: { kind: "date_time" | "all_day"; value: string }): string {
  if (start.kind === "all_day") return `${formatDateOnly(start.value)}（終日）`;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(start.value));
}

function formatDateOnly(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return "";
  return `${month}月${day}日`;
}

function GoogleSourcePicker({ service, choice, onSources, onChoose, onConnections }: {
  service: GooglePreviewService;
  choice: GoogleSourceChoice | null;
  onSources: NonNullable<HomeProps["onListGoogleSources"]>;
  onChoose: (choice: GoogleSourceChoice | null) => void;
  onConnections: () => void;
}) {
  const [items, setItems] = useState<GoogleSourceListResult["items"] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  const label = service === "calendar" ? "予定表" : "タスクリスト";
  const defaultLabel = service === "calendar" ? "メインカレンダー" : "マイタスク";
  const load = () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("loading");
    const timeout = setTimeout(() => {
      if (pending.current !== controller) return;
      controller.abort(); pending.current = null; setState("error");
    }, GOOGLE_PREVIEW_TIMEOUT_MS);
    void onSources(service, controller.signal).then((result) => {
      if (pending.current !== controller) return;
      if (result.service !== service) { setState("error"); return; }
      setItems(result.items); setState("idle");
    }, () => { if (pending.current === controller) setState("error"); }).finally(() => {
      clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    });
  };
  return <div className="home-google-source">
    <p>表示元：{choice?.title ?? defaultLabel}</p>
    <button type="button" className="home-row-action" disabled={state === "loading"} onClick={load}>表示する{label}を選ぶ</button>
    {state === "loading" ? <p role="status">{label}の一覧を確認しています</p> : null}
    {state === "error" ? <div role="alert"><p>一覧を取得できませんでした。Google連携を確認してください。</p><button type="button" onClick={onConnections}>Google連携を確認</button></div> : null}
    {items ? <label>表示する{label}<select value={choice?.id ?? ""} onChange={(event) => {
      const selected = items.find((item) => item.id === event.target.value) ?? null;
      onChoose(selected);
    }}>
      <option value="">{defaultLabel}</option>
      {choice && !items.some((item) => item.id === choice.id) ? <option value={choice.id} disabled>{choice.title}（一覧にありません）</option> : null}
      {items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label> : null}
  </div>;
}
