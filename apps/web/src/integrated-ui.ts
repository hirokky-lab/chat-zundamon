export const INTEGRATED_UI_DEFAULT_ENABLED = false;
export const INTEGRATED_UI_VIEWS = ["talk", "home", "news"] as const;

export type IntegratedUiView = typeof INTEGRATED_UI_VIEWS[number];

export function isIntegratedUiEnabled(value: unknown): boolean {
  return value === "true";
}

export function moveIntegratedUiView(
  current: IntegratedUiView,
  direction: -1 | 1,
): IntegratedUiView {
  const index = INTEGRATED_UI_VIEWS.indexOf(current);

  return INTEGRATED_UI_VIEWS[
    (index + direction + INTEGRATED_UI_VIEWS.length) % INTEGRATED_UI_VIEWS.length
  ]!;
}

export type IntegratedDataState<T> =
  | { state: "off" }
  | { state: "empty" }
  | { state: "failure" }
  | { state: "ready"; value: T };

export type ShellState = IntegratedDataState<{ readonly label: string }>;

export type IntegratedSwipeDirection = "previous" | "next";
export type HomeSection = {
  readonly id: string;
  readonly kind: "weather" | "calendar" | "tasks";
  readonly label: string;
  readonly state: "unconfigured" | "empty";
};

export type HomeViewModel = {
  readonly shellState: ShellState;
  readonly sections: readonly HomeSection[];
};

export type NewsArticle = {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly url: string;
  readonly imageUrl?: string;
};

export type NewsViewModel = IntegratedDataState<readonly NewsArticle[]>;

const INTEGRATED_DATA_STATES = ["off", "empty", "failure", "ready"] as const;

function hasKnownIntegratedDataState(model: { readonly state: string }): boolean {
  return INTEGRATED_DATA_STATES.includes(model.state as (typeof INTEGRATED_DATA_STATES)[number]);
}

export function createHomeViewModel(model: HomeViewModel): HomeViewModel {
  const ids = new Set<string>();
  for (const section of model.sections) {
    if (section.kind !== "weather" && section.kind !== "calendar" && section.kind !== "tasks") {
      throw new Error("Home sections must be weather, calendar or tasks");
    }
    if (section.kind !== "weather" && section.state !== "empty") {
      throw new Error("Calendar or tasks sections must be empty");
    }
    if (section.kind === "weather" && section.state !== "unconfigured" && section.state !== "empty") {
      throw new Error("Weather sections must be unconfigured or empty");
    }
    if (ids.has(section.id)) throw new Error("Home sections must not be duplicate");
    ids.add(section.id);
  }
  return hasKnownIntegratedDataState(model.shellState)
    ? model
    : { ...model, shellState: { state: "failure" } };
}

export function createNewsViewModel(model: NewsViewModel): NewsViewModel {
  if (!hasKnownIntegratedDataState(model)) return { state: "failure" };
  if (model.state !== "ready") return model;
  if (model.value.length > 10) throw new Error("News supports at most 10 articles");
  const ids = new Set<string>();
  for (const article of model.value) {
    if (ids.has(article.id)) throw new Error("News article IDs must not be duplicate");
    ids.add(article.id);
  }
  return model;
};

export const EMPTY_HOME_VIEW_MODEL: HomeViewModel = {
  shellState: { state: "off" },
  sections: [{ id: "weather", kind: "weather", label: "天気", state: "unconfigured" }],
};

export const EMPTY_NEWS_VIEW_MODEL: NewsViewModel = { state: "off" };

export type YuiPortrait = {
  readonly src: string;
  readonly alt: string;
};

export const DEFAULT_YUI_PORTRAIT: YuiPortrait = {
  src: "/zundamon-placeholder.svg",
  alt: "ずんだもんの代役表示（Live2D未配置）",
};
