import { ChatCircle, House, Newspaper } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, type ReactElement } from "react";
import { moveIntegratedUiView, type IntegratedUiView } from "../integrated-ui";

export type IntegratedNavigationCause = "pointer" | "keyboard";

type IntegratedNavigationProps = {
  current: IntegratedUiView;
  focusCurrent: boolean;
  onNavigate: (view: IntegratedUiView, cause: IntegratedNavigationCause) => void;
  onCurrentFocused: () => void;
};

const navigationItems = [
  { view: "talk", label: "トークへ移動", icon: ChatCircle },
  { view: "home", label: "ホームへ移動", icon: House },
  { view: "news", label: "ニュースへ移動", icon: Newspaper },
] as const;

export function IntegratedNavigation({ current, focusCurrent, onNavigate, onCurrentFocused }: IntegratedNavigationProps): ReactElement {
  const currentButtonRef = useRef<HTMLButtonElement>(null);
  const focusHandledRef = useRef(false);

  useLayoutEffect(() => {
    if (!focusCurrent) {
      focusHandledRef.current = false;
      return;
    }
    if (focusHandledRef.current) return;
    focusHandledRef.current = true;
    currentButtonRef.current?.focus({ preventScroll: true });
    onCurrentFocused();
  }, [focusCurrent, onCurrentFocused]);

  return <nav aria-label="ずんだもんの主な画面" className="integrated-navigation">
    {navigationItems.map(({ view, label, icon: Icon }) => <button
      key={view}
      ref={view === current ? currentButtonRef : undefined}
      type="button"
      className={`integrated-navigation-button${view === current ? " is-current" : ""}`}
      aria-label={label}
      aria-current={view === current ? "page" : undefined}
      data-nav-icon={view}
      onClick={() => onNavigate(view, "pointer")}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onNavigate(moveIntegratedUiView(current, event.key === "ArrowLeft" ? -1 : 1), "keyboard");
      }}
    ><Icon aria-hidden="true" weight={view === current ? "fill" : "regular"} /></button>)}
  </nav>;
}
