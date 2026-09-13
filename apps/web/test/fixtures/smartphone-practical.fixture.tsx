import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "../../src/screens/Home";
import { HomeManagement } from "../../src/screens/HomeManagement";
import { ProfileSettings } from "../../src/screens/ProfileSettings";
import type { HomeManagementModel } from "../../src/home-management";
import type { VisualStyle } from "../../src/visual-style";
import "../../src/styles.css";

type FixturePage = "home" | "connections" | "settings";
type FixtureConfig = { page: FixturePage; style: VisualStyle; scale: "normal" | "large" };

declare global { interface Window { __SMARTPHONE_PRACTICAL_READY__?: boolean } }

const query = new URLSearchParams(window.location.search);
const config = JSON.parse(query.get("config") ?? "{}") as Partial<FixtureConfig>;
if (!config.page || !["home", "connections", "settings"].includes(config.page) || !config.style || !["yui", "minimal"].includes(config.style)) {
  throw new Error("smartphone_practical_fixture_config_invalid");
}
document.documentElement.dataset.yuiStyle = config.style;
document.documentElement.style.fontSize = config.scale === "large" ? "125%" : "100%";

const managementModel: HomeManagementModel = {
  services: [
    { id: "calendar", label: "Googleカレンダー", connected: true, connectionState: "connected", homeSupported: true, homeVisible: true },
    { id: "tasks", label: "Google Tasks", connected: true, connectionState: "connected", homeSupported: true, homeVisible: true },
    { id: "drive", label: "Google Drive", connected: false, connectionState: "disabled", homeSupported: false, homeVisible: false },
    { id: "gmail", label: "Gmail", connected: false, connectionState: "disabled", homeSupported: false, homeVisible: false },
    { id: "weather", label: "天気", connected: false, connectionState: "disabled", homeSupported: true, homeVisible: false },
  ],
  widgets: [
    { id: "calendar", label: "Googleカレンダー", visible: true, configurable: true },
    { id: "tasks", label: "Google Tasks", visible: true, configurable: true },
  ],
};

function Fixture() {
  useEffect(() => {
    const timer = window.setTimeout(() => { window.__SMARTPHONE_PRACTICAL_READY__ = true; }, 50);
    return () => { window.clearTimeout(timer); delete window.__SMARTPHONE_PRACTICAL_READY__; };
  }, []);
  const noop = () => undefined;
  if (config.page === "connections") return <HomeManagement view="connections" model={managementModel} onClose={noop} onChangeView={noop} onToggleHome={noop} onToggleWidget={noop} onMoveWidget={noop} onDisconnect={noop} onConnect={noop} onSaveWeatherLocation={noop} />;
  if (config.page === "settings") return <ProfileSettings profile={{ displayName: "Fixture Owner", addressingStyle: "san", updatedAt: "2026-09-01T00:00:00.000Z" }} saving={false} error={null} onSave={noop} onClose={noop} onOpenMemories={noop} visualStyle={config.style} onVisualStyleChange={noop} integratedSheet />;
  return <Home visualStyle={config.style} navigation={<nav className="integrated-navigation" aria-label="YUIの主な画面"><button type="button" className="integrated-navigation-button">Talk</button><button type="button" className="integrated-navigation-button is-current" aria-current="page">Home</button><button type="button" className="integrated-navigation-button">News</button></nav>} model={{
    shellState: { state: "off" },
    sections: [
      { id: "calendar", kind: "calendar", label: "Googleカレンダー", state: "empty" },
      { id: "tasks", kind: "tasks", label: "Google Tasks", state: "empty" },
    ],
  }} onListGoogleSources={async (service) => ({ service, checkedAt:"2026-09-05T00:00:00.000Z", items:[{id:"work-source",title:"仕事"},{id:"personal-source",title:"個人用"}] })} onPreviewGoogleService={async (service) => service === "calendar" ? {
    service: "calendar", checkedAt: "2026-09-01T00:00:00.000Z", items: [
      { title: "長い予定名でもスマートフォンの幅からはみ出さずに表示できる確認用予定", start: { kind: "date_time", value: "2026-09-01T10:00:00+09:00" } },
    ],
  } : {
    service: "tasks", checkedAt: "2026-09-01T00:00:00.000Z", items: [
      { title: "期限付きの確認用タスク", due: "2026-09-03" },
      { title: "期限なしの確認用タスク", due: null },
    ],
  }} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("smartphone_practical_fixture_root_missing");
createRoot(root).render(<Fixture />);
