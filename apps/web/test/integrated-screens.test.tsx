import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_HOME_VIEW_MODEL,
  EMPTY_NEWS_VIEW_MODEL,
  type IntegratedUiView,
} from "../src/integrated-ui";
import { Home } from "../src/screens/Home";
import { IntegratedNavigation } from "../src/screens/IntegratedNavigation";
import { News } from "../src/screens/News";

vi.mock("@phosphor-icons/react", () => ({
  CalendarBlank: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-calendar" {...props} />,
  ChatCircle: (props: { "aria-hidden"?: boolean; weight?: string }) => <svg data-testid="icon-chat-circle" data-weight={props.weight} aria-hidden={props["aria-hidden"]} />,
  CheckSquare: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-check-square" {...props} />,
  House: (props: { "aria-hidden"?: boolean; weight?: string }) => <svg data-testid="icon-house" data-weight={props.weight} aria-hidden={props["aria-hidden"]} />,
  MapPin: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-map-pin" {...props} />,
  Newspaper: (props: { "aria-hidden"?: boolean; weight?: string }) => <svg data-testid="icon-newspaper" data-weight={props.weight} aria-hidden={props["aria-hidden"]} />,
  Plus: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-plus" {...props} />,
}));

vi.mock("@radix-ui/react-icons", () => ({
  ChatBubbleIcon: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-chat-bubble" {...props} />,
  HomeIcon: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-home" {...props} />,
  ReaderIcon: (props: { "aria-hidden"?: boolean }) => <svg data-testid="icon-reader" {...props} />,
}));

function NavigationHarness() {
  const [current, setCurrent] = useState<IntegratedUiView>("talk");
  const [pendingFocus, setPendingFocus] = useState<IntegratedUiView | null>(null);

  return <IntegratedNavigation current={current} focusCurrent={pendingFocus === current}
    onNavigate={(view, cause) => { setCurrent(view); setPendingFocus(cause === "keyboard" ? view : null); }}
    onCurrentFocused={() => setPendingFocus(null)} />;
}

describe("integrated UI screens", () => {
  it("uses the adopted prototype icon assets for the fixed shell instead of generic substitutes", () => {
    const navigationSource = readFileSync("src/screens/IntegratedNavigation.tsx", "utf8");
    const headerSource = readFileSync("src/screens/IntegratedPageHeader.tsx", "utf8");
    const chatSource = readFileSync("src/screens/Chat.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    expect(navigationSource).toContain('from "@phosphor-icons/react"');
    expect(navigationSource).toContain("ChatCircle");
    expect(navigationSource).toContain("House");
    expect(navigationSource).toContain("Newspaper");
    expect(headerSource).toContain("HamburgerMenuIcon");
    expect(headerSource).not.toContain("PersonIcon");
    expect(headerSource).toContain('src="/phone-handset.svg"');
    expect(chatSource).toContain('data-testid="composer-send-prism"');
    expect(chatSource).toContain("ZUNDAMON_CHARACTER.displayName");
    expect(headerSource).toContain("zundamon-mark");
    expect(styles).toMatch(/\.integrated-header-prism\s*\{[^}]*width:\s*29px;/s);
    expect(chatSource).toContain("Microphone");
    expect(chatSource).toContain("PlusIcon");
    expect(styles).toMatch(/\.chat-header-bar\s*\{[^}]*min-height:\s*calc\(68px \+ env\(safe-area-inset-top\)\)/s);
    expect(styles).toMatch(/\.chat-header\s*\{[^}]*border:\s*0;[^}]*background:/s);
    expect(styles).toMatch(/\.integrated-navigation-button svg\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;/s);
    expect(styles).not.toMatch(/\.integrated-navigation-button:hover[^\{]*\{/s);
  });

  it("maps the three icons, wraps arrows, moves focus, and updates non-color current state", async () => {
    const user = userEvent.setup();
    render(<NavigationHarness />);
    const talk = screen.getByRole("button", { name: "トークへ移動" });
    const home = screen.getByRole("button", { name: "ホームへ移動" });
    const news = screen.getByRole("button", { name: "ニュースへ移動" });
    expect(talk).toHaveAttribute("aria-current", "page");
    expect(talk).toHaveClass("is-current");
    expect(talk).toHaveAttribute("data-nav-icon", "talk");
    expect(home).toHaveAttribute("data-nav-icon", "home");
    expect(news).toHaveAttribute("data-nav-icon", "news");
    expect(talk).toContainElement(screen.getByTestId("icon-chat-circle"));
    expect(home).toContainElement(screen.getByTestId("icon-house"));
    expect(news).toContainElement(screen.getByTestId("icon-newspaper"));
    expect(screen.getByTestId("icon-chat-circle")).toHaveAttribute("data-weight", "fill");
    expect(screen.getByTestId("icon-house")).toHaveAttribute("data-weight", "regular");
    expect(screen.getByTestId("icon-newspaper")).toHaveAttribute("data-weight", "regular");
    expect(talk).toHaveTextContent("");
    expect(home).toHaveTextContent("");
    expect(news).toHaveTextContent("");
    talk.focus();
    await user.keyboard("{ArrowLeft}");
    expect(news).toHaveFocus();
    expect(news).toHaveAttribute("aria-current", "page");
    expect(talk).not.toHaveAttribute("aria-current");
    await user.keyboard("{ArrowRight}");
    expect(talk).toHaveFocus();
    expect(talk).toHaveAttribute("aria-current", "page");
    await user.click(home);
    expect(home).toHaveFocus();
    expect(home).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("icon-chat-circle")).toHaveAttribute("data-weight", "regular");
    expect(screen.getByTestId("icon-house")).toHaveAttribute("data-weight", "fill");
  });

  it("uses a non-portrait failure message, keeps the home shell after an image error, and resets for a replacement src", () => {
    const navigation = <div>navigation</div>;
    const { rerender } = render(<Home navigation={navigation} model={EMPTY_HOME_VIEW_MODEL} />);
    expect(screen.queryByRole("img", { name: "SDずんだもん" })).not.toBeInTheDocument();
    rerender(<Home navigation={navigation} model={EMPTY_HOME_VIEW_MODEL} portrait={{ src: "/first.png", alt: "SDずんだもん" }} />);
    fireEvent.error(screen.getByRole("img", { name: "SDずんだもん" }));
    expect(screen.queryByRole("img", { name: "SDずんだもん" })).not.toBeInTheDocument();
    expect(screen.getByText("ずんだもんの画像を表示できません")).toHaveClass("yui-portrait-failure");
    expect(document.querySelector(".yui-portrait-fallback")).not.toBeInTheDocument();
    rerender(<Home navigation={navigation} model={EMPTY_HOME_VIEW_MODEL} portrait={{ src: "/replacement.png", alt: "SDずんだもん" }} />);
    expect(screen.getByRole("img", { name: "SDずんだもん" })).toHaveAttribute("src", "/replacement.png");
    expect(screen.getByRole("heading", { name: "ホーム" })).toBeVisible();
    expect(screen.getByText("天気はまだ表示していません。地域を決めると、ここに出せます。")).toBeVisible();
  });

  it("uses fine-divider Home rows, keeps Weather free of a talk action, and gives Calendar and Tasks a 44px talk action seam", () => {
    render(<Home navigation={<div />} model={{
      shellState: { state: "off" },
      sections: [
        { id: "weather", kind: "weather", label: "天気", state: "unconfigured" },
        { id: "calendar", kind: "calendar", label: "Calendar", state: "empty" },
        { id: "tasks", kind: "tasks", label: "Tasks", state: "empty" },
      ],
    }} />);

    const weather = screen.getByRole("heading", { name: "天気" }).closest("section")!;
    expect(weather).toHaveClass("home-section");
    expect(weather.querySelector("[data-home-conversation-action]")).not.toBeInTheDocument();
    for (const label of ["Calendar", "Tasks"]) {
      const section = screen.getByRole("heading", { name: label }).closest("section")!;
      expect(section).toHaveClass("home-section");
      expect(section).not.toHaveTextContent("確認しました");
      const action = section.querySelector("[data-home-conversation-action]");
      expect(action).toHaveClass("home-context-action");
      expect(action).toHaveAccessibleName(`${label}についてずんだもんに話す`);
    }
  });

  it("loads Calendar and Tasks content only after an explicit tap and clears it when Home evidence disappears", async () => {
    const user = userEvent.setup();
    const onPreviewGoogleService = vi.fn(async (service: "calendar" | "tasks") => service === "calendar"
      ? {
        service: "calendar" as const,
        checkedAt: "2026-09-01T01:02:03.000Z",
        items: [{ title: "朝会", start: { kind: "date_time" as const, value: "2026-09-01T10:00:00+09:00" } }],
      }
      : {
        service: "tasks" as const,
        checkedAt: "2026-09-01T01:02:03.000Z",
        items: [{ title: "資料を確認", due: "2026-09-03" }],
      });
    const model = {
      shellState: { state: "off" as const },
      sections: [
        { id: "calendar", kind: "calendar" as const, label: "Googleカレンダー", state: "empty" as const },
        { id: "tasks", kind: "tasks" as const, label: "Google Tasks", state: "empty" as const },
      ],
    };
    const view = render(<Home navigation={<div />} model={model} onPreviewGoogleService={onPreviewGoogleService} />);

    expect(screen.queryByText("朝会")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Googleカレンダーの内容を見る" }));
    expect(await screen.findByText("朝会")).toBeVisible();
    const calendarTime = screen.getByRole("list", { name: "予定の内容" }).querySelector("time");
    expect(calendarTime).toHaveTextContent("9/1");
    expect(calendarTime).not.toHaveTextContent("2026-09-01T10:00:00+09:00");
    expect(onPreviewGoogleService).toHaveBeenCalledWith("calendar", expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "Google Tasksの内容を見る" }));
    expect(await screen.findByText("資料を確認")).toBeVisible();
    expect(screen.getByText("期限: 9月3日")).toBeVisible();

    view.rerender(<Home navigation={<div />} model={{ shellState: { state: "off" }, sections: [] }} onPreviewGoogleService={onPreviewGoogleService} />);
    await waitFor(() => expect(screen.queryByText("朝会")).not.toBeInTheDocument());
    view.rerender(<Home navigation={<div />} model={model} onPreviewGoogleService={onPreviewGoogleService} />);
    expect(screen.queryByText("朝会")).not.toBeInTheDocument();
    expect(screen.queryByText("資料を確認")).not.toBeInTheDocument();
  });

  it("selects a non-default source and discards old preview when the selection changes", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onPreview = vi.fn(async () => ({service: "calendar" as const, checkedAt: "2026-09-05T01:00:00Z", items: [{title:"古い予定",start:{kind:"all_day" as const,value:"2026-09-06"}}]}));
    const onSources = vi.fn(async () => ({service:"calendar" as const,checkedAt:"2026-09-05T01:00:00Z",items:[{id:"work@example.test",title:"仕事"}]}));
    render(<Home navigation={<div />} model={{shellState:{state:"off"},sections:[{id:"calendar",kind:"calendar",label:"Googleカレンダー",state:"empty"}]}} onPreviewGoogleService={onPreview} onListGoogleSources={onSources} googleSourceChoices={{get:()=>null,set:onChoose}} />);
    await user.click(screen.getByRole("button",{name:"Googleカレンダーの内容を見る"}));
    expect(await screen.findByText("古い予定")).toBeVisible();
    await user.click(screen.getByRole("button",{name:"表示する予定表を選ぶ"}));
    await user.selectOptions(await screen.findByRole("combobox",{name:"表示する予定表"}),"work@example.test");
    expect(screen.queryByText("古い予定")).not.toBeInTheDocument();
    expect(onChoose).toHaveBeenCalledWith("calendar",{id:"work@example.test",title:"仕事"});
    await user.click(screen.getByRole("button",{name:"Googleカレンダーの内容を見る"}));
    expect(onPreview).toHaveBeenLastCalledWith("calendar",expect.any(AbortSignal),"work@example.test");
  });

  it("returns a failed Home preview to a retryable fixed error without provider details", async () => {
    const user = userEvent.setup();
    const onPreviewGoogleService = vi.fn(async () => { throw new Error("private provider body"); });
    render(<Home navigation={<div />} model={{
      shellState: { state: "off" },
      sections: [{ id: "calendar", kind: "calendar", label: "Googleカレンダー", state: "empty" }],
    }} onPreviewGoogleService={onPreviewGoogleService} />);

    await user.click(screen.getByRole("button", { name: "Googleカレンダーの内容を見る" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("内容を確認できませんでした。時間をおいてもう一度お試しください。");
    expect(screen.getByRole("button", { name: "Googleカレンダーの内容を再試行" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("private provider body");
  });

  it("releases a permanently pending preview after 15 seconds and ignores its stale result", async () => {
    vi.useFakeTimers();
    let resolvePreview: ((value: { service: "calendar"; checkedAt: string; items: readonly [] }) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const onPreviewGoogleService = vi.fn((_service: "calendar" | "tasks", signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<{ service: "calendar"; checkedAt: string; items: readonly [] }>((resolve) => { resolvePreview = resolve; });
    });
    render(<Home navigation={<div />} model={{
      shellState: { state: "off" },
      sections: [{ id: "calendar", kind: "calendar", label: "Googleカレンダー", state: "empty" }],
    }} onPreviewGoogleService={onPreviewGoogleService} />);

    try {
      act(() => screen.getByRole("button", { name: "Googleカレンダーの内容を見る" }).click());
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(observedSignal?.aborted).toBe(true);
      expect(screen.getByRole("alert")).toHaveTextContent("内容を確認できませんでした。時間をおいてもう一度お試しください。");
      expect(screen.getByRole("button", { name: "Googleカレンダーの内容を再試行" })).toBeEnabled();
      await act(async () => {
        resolvePreview?.({ service: "calendar", checkedAt: "2026-09-01T01:02:03.000Z", items: [] });
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.queryByText("表示できる予定はありません")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight preview when its Home evidence disappears", async () => {
    let observedSignal: AbortSignal | undefined;
    const onPreviewGoogleService = vi.fn((_service: "calendar" | "tasks", signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const model = { shellState: { state: "off" as const }, sections: [{ id: "calendar", kind: "calendar" as const, label: "Googleカレンダー", state: "empty" as const }] };
    const view = render(<Home navigation={<div />} model={model} onPreviewGoogleService={onPreviewGoogleService} />);
    screen.getByRole("button", { name: "Googleカレンダーの内容を見る" }).click();

    view.rerender(<Home navigation={<div />} model={{ shellState: { state: "off" }, sections: [] }} onPreviewGoogleService={onPreviewGoogleService} />);

    expect(observedSignal?.aborted).toBe(true);
  });

  it("admits only one same-service preview request in a shared React batch", () => {
    const onPreviewGoogleService = vi.fn(() => new Promise<never>(() => undefined));
    render(<Home navigation={<div />} model={{
      shellState: { state: "off" },
      sections: [{ id: "calendar", kind: "calendar", label: "Googleカレンダー", state: "empty" }],
    }} onPreviewGoogleService={onPreviewGoogleService} />);
    const button = screen.getByRole("button", { name: "Googleカレンダーの内容を見る" });

    act(() => { button.click(); button.click(); });

    expect(onPreviewGoogleService).toHaveBeenCalledOnce();
  });

  it("shows only evidence-backed P0 Home shell states and hides the OFF cue in Minimal", () => {
    const off = { shellState: { state: "off" as const }, sections: [] };
    const { rerender } = render(<Home navigation={<div />} model={off} visualStyle="yui" />);
    expect(screen.getByText("接続していない情報は、ずんだもんは取りに行きません。")).toBeVisible();
    expect(screen.queryByText(/確認しました/)).not.toBeInTheDocument();

    rerender(<Home navigation={<div />} model={off} visualStyle="minimal" />);
    expect(screen.queryByText("接続していない情報は、ずんだもんは取りに行きません。")).not.toBeInTheDocument();

    rerender(<Home navigation={<div />} model={{ shellState: { state: "empty" }, sections: [] }} visualStyle="yui" />);
    expect(screen.getByText("確認しましたが、いま表示できる情報はありません。")).toBeVisible();

    rerender(<Home navigation={<div />} model={{ shellState: { state: "failure" }, sections: [] }} visualStyle="yui" />);
    expect(screen.getByText("いまは情報を表示できません。トークはそのまま使えます。")).toBeVisible();

    rerender(<Home navigation={<div />} model={{ shellState: { state: "ready", value: { label: "確認済み" } }, sections: [] }} visualStyle="yui" />);
    expect(screen.queryByText("確認済み")).not.toBeInTheDocument();
    expect(screen.queryByText("いまは情報を表示できません。トークはそのまま使えます。")).not.toBeInTheDocument();
    expect(readFileSync("src/App.tsx", "utf8")).toMatch(/<Home[^>]*visualStyle=\{visualStyle\}/su);
  });

  it("fails unknown Home and News shell states closed to the existing failure copy", () => {
    render(<>
      <Home navigation={<div />} model={{ shellState: { state: "unknown" }, sections: [] } as never} visualStyle="yui" />
      <News navigation={<div />} model={{ state: "unknown" } as never} />
    </>);

    expect(screen.getAllByText("いまは情報を表示できません。トークはそのまま使えます。")).toHaveLength(2);
    expect(screen.queryByText(/確認しました/u)).not.toBeInTheDocument();
  });

  it("exposes the integrated page and portrait styling seams", () => {
    render(<><Home navigation={<nav aria-label="ホーム側ナビ" />} model={EMPTY_HOME_VIEW_MODEL} portrait={{ src: "/portrait.png", alt: "SDずんだもん" }} /><News navigation={<nav aria-label="ニュース側ナビ" />} model={EMPTY_NEWS_VIEW_MODEL} /></>);
    const home = screen.getByRole("heading", { name: "ホーム" }).closest("main")!;
    const news = screen.getByRole("heading", { name: "ニュース" }).closest("main")!;
    expect(home).toHaveClass("integrated-page");
    expect(news).toHaveClass("integrated-page");
    expect(home.querySelector(".integrated-page-scroll")).toContainElement(screen.getByRole("heading", { name: "ホーム" }));
    expect(news.querySelector(".integrated-page-scroll")).toContainElement(screen.getByRole("heading", { name: "ニュース" }));
    expect(home.querySelector(".integrated-page-scroll")).not.toContainElement(screen.getByRole("navigation", { name: "ホーム側ナビ" }));
    expect(news.querySelector(".integrated-page-scroll")).not.toContainElement(screen.getByRole("navigation", { name: "ニュース側ナビ" }));
    expect(screen.getByRole("img", { name: "SDずんだもん" })).toHaveClass("yui-portrait");
    expect(readFileSync("src/styles.css", "utf8")).toMatch(/\.yui-portrait\s*\{[^}]*image-rendering:\s*pixelated;/u);
  });

  it("keeps the News heading accessible but removes the visible OFF heading", () => {
    render(<News navigation={<div />} model={EMPTY_NEWS_VIEW_MODEL} />);
    expect(screen.getByRole("heading", { name: "ニュース" })).toHaveClass("sr-only");
    expect(screen.getByText("ずんだもんはニュースを取りに行っていません。利用できる情報だけをここに表示します。トークはそのまま使えます。")).toBeVisible();
    expect(screen.queryByText(/確認しました/u)).not.toBeInTheDocument();
  });

  it("renders the approved Home structure and opens local weather and Home management", async () => {
    const user = userEvent.setup();
    const onOpenHomeManagement = vi.fn();
    render(<Home navigation={<div />} model={EMPTY_HOME_VIEW_MODEL} onOpenHomeManagement={onOpenHomeManagement} />);
    expect(screen.getByLabelText("SDずんだもんの表示枠")).toBeVisible();
    expect(screen.getByText("無理しすぎず、今日もぼちぼちいこう")).toBeVisible();
    expect(screen.getByText(/月.*日/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "天気の地域を設定" })).toBeVisible();
    expect(screen.getByRole("button", { name: "接続サービスを追加" })).toBeVisible();
    expect(screen.getByRole("button", { name: "ホームを編集" })).toBeVisible();
    expect(screen.queryByText("15:00 企画確認")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "天気の地域を設定" }));
    expect(onOpenHomeManagement).toHaveBeenCalledWith("weather");
  });

  it("does not render a configured weather widget while its Home placement is off", () => {
    render(<Home navigation={<div />} model={{ ...EMPTY_HOME_VIEW_MODEL, sections: [] }} />);
    expect(screen.queryByRole("heading", { name: "天気" })).not.toBeInTheDocument();
  });

  it("offers no Drive, Gmail, or Codex Home control", () => {
    render(<Home navigation={<div />} model={EMPTY_HOME_VIEW_MODEL} />);
    expect(screen.queryByRole("button", { name: /Google Drive.*ホーム/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gmail.*ホーム/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Codex.*ホーム/u })).not.toBeInTheDocument();
  });

  it("fails closed instead of rendering raw Home services with an unconnected, unknown, or duplicate identity", () => {
    const base = { shellState: { state: "off" as const } };
    const invalidState = { ...base, sections: [{ id: "tasks-1", kind: "tasks", label: "タスク", state: "ready" }] } as never;
    const unknown = { ...base, sections: [{ id: "mail-1", kind: "mail", label: "メール", state: "empty" }] } as never;
    const duplicate = { ...base, sections: [{ id: "tasks-1", kind: "tasks", label: "タスクA", state: "empty" }, { id: "tasks-1", kind: "tasks", label: "タスクB", state: "empty" }] } as never;
    expect(() => render(<Home navigation={<div />} model={invalidState} />)).toThrow("empty");
    expect(() => render(<Home navigation={<div />} model={unknown} />)).toThrow("calendar or tasks");
    expect(() => render(<Home navigation={<div />} model={duplicate} />)).toThrow("duplicate");
    expect(screen.queryByText("未接続タスク")).not.toBeInTheDocument();
  });

  it("keeps article links and conversation actions separate across typed News states", async () => {
    const user = userEvent.setup();
    const onStartConversation = vi.fn();
    const ready = {
      state: "ready" as const,
      value: [{ id: "article-1", title: "記事の題名", source: "公式", publishedAt: "2026-08-14T00:00:00.000Z", url: "https://example.com/article" }],
    };
    const { rerender } = render(<News navigation={<div />} model={ready} onStartConversation={onStartConversation} />);
    expect(screen.getByRole("link", { name: "記事の題名" })).toHaveAttribute("href", "https://example.com/article");
    await user.click(screen.getByRole("button", { name: "記事の題名についてずんだもんに話す" }));
    expect(onStartConversation).toHaveBeenCalledWith("記事の題名");
    rerender(<News navigation={<div />} model={{ state: "empty" }} />);
    expect(screen.getByText("確認しましたが、表示できる情報はまだありません。")).toBeVisible();
    rerender(<News navigation={<div />} model={{ state: "failure" }} />);
    expect(screen.getByText("いまは情報を表示できません。トークはそのまま使えます。")).toBeVisible();
  });

  it("fails closed instead of rendering raw News models with more than ten or duplicate articles", () => {
    const article = (id: string) => ({ id, title: `記事 ${id}`, source: "公式", publishedAt: "2026-08-14T00:00:00.000Z", url: `https://example.com/${id}` });
    const eleven = { state: "ready", value: Array.from({ length: 11 }, (_, index) => article(String(index))) } as never;
    const duplicate = { state: "ready", value: [article("duplicate"), article("duplicate")] } as never;
    expect(() => render(<News navigation={<div />} model={eleven} />)).toThrow("at most 10");
    expect(() => render(<News navigation={<div />} model={duplicate} />)).toThrow("duplicate");
    expect(screen.queryByRole("link", { name: "記事 10" })).not.toBeInTheDocument();
  });

  it("marks image News rows so their thumbnail, text, and conversation control occupy three columns", () => {
    render(<News navigation={<div />} model={{ state: "ready", value: [{ id: "with-image", title: "画像付き記事", source: "公式", publishedAt: "2026-08-14T00:00:00.000Z", url: "https://example.com/image", imageUrl: "/thumbnail.jpg" }] }} />);
    const row = screen.getByRole("link", { name: "画像付き記事" }).closest("li")!;
    expect(row).toHaveClass("has-image");
    expect(row.querySelector("img")).toHaveAttribute("src", "/thumbnail.jpg");
    expect(row.querySelector("button")).toHaveAccessibleName("画像付き記事についてずんだもんに話す");
  });

  it("renders only abstract shell states and makes no request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      render(<><Home navigation={<div />} model={EMPTY_HOME_VIEW_MODEL} /><News navigation={<div />} model={EMPTY_NEWS_VIEW_MODEL} /></>);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByText("ずんだもんはニュースを取りに行っていません。利用できる情報だけをここに表示します。トークはそのまま使えます。")).toBeVisible();
    } finally {
      fetchSpy.mockRestore();
    }
  });

});
