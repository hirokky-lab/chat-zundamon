export type HomeServiceId = "weather" | "calendar" | "tasks" | "drive" | "gmail";

export type HomeService = {
  readonly id: HomeServiceId;
  readonly label: string;
  readonly connected: boolean;
  readonly connectionState?: "disabled" | "disconnected" | "connected";
  readonly homeSupported: boolean;
  readonly homeVisible: boolean;
};

export type HomeWidget = {
  readonly id: Extract<HomeServiceId, "weather" | "calendar" | "tasks">;
  readonly label: string;
  readonly visible: boolean;
  readonly configurable: boolean;
};

export type HomeManagementModel = {
  readonly services: readonly HomeService[];
  readonly widgets: readonly HomeWidget[];
  readonly weatherLocation?: string;
};

export type HomeManagementView = "home" | "connections" | "weather";

export const EMPTY_HOME_MANAGEMENT_MODEL: HomeManagementModel = {
  services: [
    { id: "calendar", label: "Googleカレンダー", connected: false, connectionState: "disabled", homeSupported: true, homeVisible: false },
    { id: "tasks", label: "Google Tasks", connected: false, connectionState: "disabled", homeSupported: true, homeVisible: false },
    { id: "drive", label: "Google Drive", connected: false, connectionState: "disabled", homeSupported: false, homeVisible: false },
    { id: "gmail", label: "Gmail", connected: false, connectionState: "disabled", homeSupported: false, homeVisible: false },
    { id: "weather", label: "天気", connected: false, connectionState: "disabled", homeSupported: true, homeVisible: false },
  ],
  widgets: [],
};

function serviceById(model: HomeManagementModel, id: HomeServiceId): HomeService {
  const service = model.services.find((candidate) => candidate.id === id);
  if (!service) throw new Error("Unknown Home service");
  return service;
}

export function setHomeServiceConnection(
  model: HomeManagementModel,
  id: HomeServiceId,
  connected: boolean,
): HomeManagementModel {
  const current = serviceById(model, id);
  const preservePlacement = connected && current.connected;

  return {
    ...model,
    services: model.services.map((service) => service.id === id
      ? { ...service, connected, homeVisible: preservePlacement ? service.homeVisible : false }
      : service),
    widgets: preservePlacement ? model.widgets : model.widgets.filter((widget) => widget.id !== id),
    ...(id === "weather" && !connected ? { weatherLocation: undefined } : {}),
  };
}

export function setHomeWeatherLocation(model: HomeManagementModel, location: string): HomeManagementModel {
  const normalized = location.trim();
  if (!normalized) throw new Error("Weather location is required");
  return { ...setHomeServiceConnection(model, "weather", true), weatherLocation: normalized };
}

export function toHomeViewModel(model: HomeManagementModel): import("./integrated-ui").HomeViewModel {
  const services = new Map(model.services.map((service) => [service.id, service]));
  const sections: import("./integrated-ui").HomeSection[] = model.widgets.flatMap((widget) => {
    const service = services.get(widget.id);
    if (!widget.visible || !service?.connected || !service.homeVisible || !service.homeSupported) return [];
    return [{
      id: widget.id,
      kind: widget.id,
      label: widget.label,
      state: "empty" as const,
    }];
  });
  const weather = services.get("weather");
  if (weather && !weather.connected && !sections.some((section) => section.kind === "weather")) {
    sections.push({ id: "weather", kind: "weather", label: weather.label, state: "unconfigured" });
  }

  return {
    shellState: { state: "off" },
    sections,
  };
}

export function setHomeServiceHomeVisible(
  model: HomeManagementModel,
  id: HomeServiceId,
  visible: boolean,
): HomeManagementModel {
  const service = serviceById(model, id);
  if (!service.connected) throw new Error("Home service must be connected");
  if (!service.homeSupported) throw new Error("Service does not support Home");

  const supportedId = service.id as HomeWidget["id"];
  const widgets = visible
    ? model.widgets.some((widget) => widget.id === supportedId)
      ? model.widgets.map((widget) => widget.id === supportedId ? { ...widget, visible: true } : widget)
      : [...model.widgets, { id: supportedId, label: service.label, visible: true, configurable: true }]
    : model.widgets.filter((widget) => widget.id !== supportedId);

  return {
    ...model,
    services: model.services.map((candidate) => candidate.id === id
      ? { ...candidate, homeVisible: visible }
      : candidate),
    widgets,
  };
}

export function moveHomeWidget(
  model: HomeManagementModel,
  id: HomeWidget["id"],
  direction: -1 | 1,
): HomeManagementModel {
  const widgets = [...model.widgets];
  const index = widgets.findIndex((widget) => widget.id === id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= widgets.length) return model;
  [widgets[index], widgets[nextIndex]] = [widgets[nextIndex]!, widgets[index]!];
  return { ...model, widgets };
}
