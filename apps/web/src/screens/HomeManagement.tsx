import { ArrowDown, ArrowLeft, ArrowUp, DotsThree } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type {
  HomeManagementModel,
  HomeManagementView,
  HomeServiceId,
  HomeWidget,
} from "../home-management";

const CONNECTION_ACTION_TIMEOUT_MS = 15_000;

type HomeManagementProps = {
  view: HomeManagementView;
  model: HomeManagementModel;
  onClose: () => void;
  onChangeView: (view: HomeManagementView) => void;
  onToggleHome: (id: HomeServiceId) => void;
  onToggleWidget: (id: HomeWidget["id"]) => void;
  onMoveWidget: (id: HomeWidget["id"], direction: -1 | 1) => void;
  onDisconnect: (id: HomeServiceId) => Promise<void> | void;
  onConnect?: (id: Extract<HomeServiceId, "calendar" | "tasks">) => Promise<void> | void;
  onSaveWeatherLocation: (location: string) => void;
};

export function HomeManagement({
  view,
  model,
  onClose,
  onChangeView,
  onToggleHome,
  onToggleWidget,
  onMoveWidget,
  onDisconnect,
  onConnect,
  onSaveWeatherLocation,
}: HomeManagementProps): ReactElement {
  const [openMenu, setOpenMenu] = useState<HomeServiceId | null>(null);
  const [weatherLocation, setWeatherLocation] = useState(model.weatherLocation ?? "");
  const [connectionAction, setConnectionAction] = useState<HomeServiceId | null>(null);
  const [connectionError, setConnectionError] = useState<HomeServiceId | null>(null);
  const [connectionRetryBlocked, setConnectionRetryBlocked] = useState(false);
  const actionInFlight = useRef(false);
  const actionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    if (actionTimeout.current) clearTimeout(actionTimeout.current);
    actionTimeout.current = null;
  }, []);
  const addableServices = model.services.filter((service) => (
    service.homeSupported && service.connected && !service.homeVisible
  ));
  const title = view === "home" ? "ホームを編集" : view === "connections" ? "接続サービス" : "天気の地域を設定";
  const saveWeather = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const location = weatherLocation.trim();
    if (location) onSaveWeatherLocation(location);
  };
  const runConnectionAction = (service: HomeServiceId, action: () => Promise<void> | void) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setConnectionAction(service);
    setConnectionError(null);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      actionTimeout.current = null;
      if (!mounted.current) return;
      setConnectionError(service);
      setConnectionRetryBlocked(true);
      setConnectionAction(null);
    }, CONNECTION_ACTION_TIMEOUT_MS);
    actionTimeout.current = timeout;
    void Promise.resolve().then(action).catch(() => {
      if (!timedOut && mounted.current) setConnectionError(service);
    }).finally(() => {
      if (actionTimeout.current === timeout) {
        clearTimeout(timeout);
        actionTimeout.current = null;
      }
      actionInFlight.current = false;
      if (mounted.current) {
        setConnectionRetryBlocked(false);
        setConnectionAction(null);
      }
    });
  };
  const serviceLabel = (service: HomeServiceId) => model.services.find(({ id }) => id === service)?.label ?? "接続サービス";

  return <main className="integrated-page management-screen">
    <header className="management-header">
      <button type="button" aria-label="ホームに戻る" onClick={onClose}><ArrowLeft aria-hidden="true" size={22} /></button>
      <h1>{title}</h1>
    </header>
    <div className="management-content">
      {view === "home" ? <>
        <section className="management-section" aria-labelledby="visible-widgets-heading">
          <h2 id="visible-widgets-heading">表示中</h2>
          {model.widgets.length === 0 ? <>
            <p className="management-empty">表示中のウィジェットはありません</p>
            <p className="management-empty">接続済みサービスはトークで引き続き利用できます</p>
          </> : null}
          <ul className="management-list">
            {model.widgets.map((widget, index) => <li className="management-row" key={widget.id}>
              <div className="management-row-main"><span>{widget.label}</span></div>
              <div className="management-row-actions">
                <button type="button" aria-label={`${widget.label}を上へ移動`} disabled={index === 0} onClick={() => onMoveWidget(widget.id, -1)}><ArrowUp aria-hidden="true" size={20} /></button>
                <button type="button" aria-label={`${widget.label}を下へ移動`} disabled={index === model.widgets.length - 1} onClick={() => onMoveWidget(widget.id, 1)}><ArrowDown aria-hidden="true" size={20} /></button>
                {widget.id === "weather" ? <button type="button" onClick={() => onChangeView("weather")}>天気の地域を設定</button> : null}
                <button className="management-switch-control" type="button" role="switch" aria-label={`${widget.label}をホームに表示`} aria-checked={widget.visible} onClick={() => onToggleWidget(widget.id)}><span aria-hidden="true" className="management-switch-track"><span className="management-switch-thumb" /></span></button>
              </div>
            </li>)}
          </ul>
        </section>
        <section className="management-section" aria-labelledby="add-widgets-heading">
          <h2 id="add-widgets-heading">ウィジェットを追加</h2>
          <ul className="management-list">
            {addableServices.map((service) => <li className="management-row" key={service.id}>
              <div className="management-row-main"><span>{service.label}</span></div>
              <div className="management-row-actions"><button type="button" onClick={() => onToggleHome(service.id)}>{service.label}をホームに追加</button></div>
            </li>)}
          </ul>
          {addableServices.length === 0 ? <p className="management-empty">追加できる接続済みサービスはありません</p> : null}
        </section>
        <button className="management-view-link" type="button" onClick={() => onChangeView("connections")}>接続サービスを管理</button>
      </> : view === "connections" ? <>
        <section className="management-section" aria-labelledby="connections-heading" aria-busy={connectionAction !== null || undefined}>
          <h2 id="connections-heading">接続サービス一覧</h2>
          {connectionAction ? <p role="status">{serviceLabel(connectionAction)}を変更しています</p> : null}
          {connectionError ? <p role="alert">{connectionRetryBlocked ? `${serviceLabel(connectionError)}の確認が終わるまで再試行できません。` : `${serviceLabel(connectionError)}の状態を変更できませんでした。もう一度お試しください。`}</p> : null}
          <ul className="management-list">
            {model.services.filter(service => service.id !== "tasks" && service.id !== "weather").map((service) => <li className="management-row" key={service.id}>
              <div className="management-row-main"><strong>{service.label}</strong><span className="management-status">{service.connected ? "接続済み" : service.connectionState === "disabled" ? "利用不可" : "未接続"}</span></div>
              <div className="management-row-actions">
                {service.connected ? <button type="button" disabled={connectionAction !== null || connectionRetryBlocked} aria-label={`${service.label}のその他の操作`} aria-expanded={openMenu === service.id} onClick={() => setOpenMenu((current) => current === service.id ? null : service.id)}><DotsThree aria-hidden="true" size={22} /></button> : null}
                {!service.connected && service.connectionState === "disconnected" && isGoogleService(service.id) && onConnect
                  ? <button type="button" disabled={connectionAction !== null || connectionRetryBlocked} onClick={() => {
                    const googleService = service.id as "calendar" | "tasks";
                    runConnectionAction(googleService, () => onConnect(googleService));
                  }}>{service.label}を接続</button>
                  : null}
              </div>
              {openMenu === service.id ? <div className="management-disconnect-menu">
                <p>取得を止め、対象キャッシュを削除します。再接続してもホーム表示は戻りません</p>
                <button type="button" disabled={connectionAction !== null || connectionRetryBlocked} onClick={() => { setOpenMenu(null); runConnectionAction(service.id, () => onDisconnect(service.id)); }}>{service.label}の接続を解除</button>
              </div> : null}
            </li>)}
          </ul>
        </section>
      </> : <>
        <form onSubmit={saveWeather}>
          <section className="management-section" aria-labelledby="weather-location-heading">
            <h2 id="weather-location-heading">地域</h2>
            <input aria-label="地域" value={weatherLocation} onChange={(event) => setWeatherLocation(event.target.value)} />
          </section>
          <button className="management-view-link" type="submit" disabled={!weatherLocation.trim()}>地域を保存</button>
        </form>
      </>}
    </div>
  </main>;
}

function isGoogleService(id: HomeServiceId): id is "calendar" | "tasks" {
  return id === "calendar" || id === "tasks";
}
