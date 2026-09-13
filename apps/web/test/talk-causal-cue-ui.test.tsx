import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_LOCAL_CHAT } from "../src/local-state";
import { Chat } from "../src/screens/Chat";
import type { TalkCausalCue } from "../src/talk-causal-cue";

const now = "2026-08-29T08:00:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: now };

function renderCue(cue: TalkCausalCue | null, options: { enabled?: boolean; style?: "yui" | "minimal"; timeline?: typeof EMPTY_LOCAL_CHAT.timeline; callPreparing?: boolean; dictationState?: "idle" | "recording" } = {}) {
  return render(<Chat
    state={{ profile, openingRequestId: null, failureByMessageId: {}, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: options.timeline ?? [] } }}
    delayedGreetingReplyGroupId={null}
    onGreetingRevealed={vi.fn()}
    hydrating={false}
    persistenceWarning={false}
    onSend={vi.fn()}
    onRetry={vi.fn()}
    onCall={vi.fn()}
    onOpenSettings={vi.fn()}
    causalCueEnabled={options.enabled ?? true}
    causalCue={cue}
    visualStyle={options.style ?? "yui"}
    callPreparing={options.callPreparing}
    dictationState={options.dictationState}
  />);
}

describe("Talk causal cue UI fixture", () => {
  it("shows the approved static empty cue only for an enabled YUI fixture", () => {
    const view = renderCue(null);
    expect(screen.getByText("ここから、話を受け取る")).not.toHaveAttribute("role");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.unmount();

    renderCue(null, { style: "minimal" });
    expect(screen.queryByText("ここから、話を受け取る")).not.toBeInTheDocument();
  });

  it("keeps the display-only feature absent by default", () => {
    render(<Chat
      state={{ profile, openingRequestId: null, failureByMessageId: {}, snapshot: EMPTY_LOCAL_CHAT }}
      delayedGreetingReplyGroupId={null}
      onGreetingRevealed={vi.fn()}
      hydrating={false}
      persistenceWarning={false}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCall={vi.fn()}
      onOpenSettings={vi.fn()}
      causalCue={{ phase: "waiting", requestId: "message-1" }}
      visualStyle="yui"
    />);

    expect(screen.queryByText("ずんだもんが返事をつくっています")).not.toBeInTheDocument();
  });

  it("shows the approved received and waiting copy once in the shared polite status channel", () => {
    const pending = [
      { id: "message-1", type: "message" as const, role: "user" as const, text: "こんにちは", createdAt: now, delivery: "sending" as const },
      { id: "reply-1:0", type: "message" as const, role: "assistant" as const, text: "こんにちは", createdAt: now, delivery: "sent" as const, replyGroupId: "reply-1", sequence: 0 as const },
    ];
    const view = renderCue({ phase: "received", requestId: "message-1" }, { timeline: pending });
    const causalStatus = screen.getByRole("status", { name: "ずんだもんが返事をつくっています" });
    expect(causalStatus).toHaveAccessibleName("ずんだもんが返事をつくっています");
    expect(causalStatus.querySelectorAll(".typing-dot")).toHaveLength(3);
    expect(screen.queryByLabelText("ずんだもんが入力中")).not.toBeInTheDocument();

    view.rerender(<Chat
      state={{ profile, openingRequestId: null, failureByMessageId: {}, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: pending } }}
      delayedGreetingReplyGroupId={null}
      onGreetingRevealed={vi.fn()}
      hydrating={false}
      persistenceWarning={false}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCall={vi.fn()}
      onOpenSettings={vi.fn()}
      causalCueEnabled
      causalCue={{ phase: "waiting", requestId: "message-1" }}
      visualStyle="yui"
    />);
    expect(screen.getByRole("status", { name: "ずんだもんが返事をつくっています" })).toBe(causalStatus);
    expect(causalStatus).toHaveAccessibleName("ずんだもんが返事をつくっています");
    expect(screen.getAllByRole("status", { name: "ずんだもんが返事をつくっています" })).toHaveLength(1);

    const deliveredTimeline = [
      { ...pending[0], delivery: "sent" as const },
      pending[1],
    ];
    view.rerender(<Chat
      state={{ profile, openingRequestId: null, failureByMessageId: {}, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: deliveredTimeline } }}
      delayedGreetingReplyGroupId={null}
      onGreetingRevealed={vi.fn()}
      hydrating={false}
      persistenceWarning={false}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCall={vi.fn()}
      onOpenSettings={vi.fn()}
      causalCueEnabled
      causalCue={{ phase: "delivered", requestId: "message-1", replyGroupId: "reply-1" }}
      visualStyle="yui"
    />);
    expect(screen.getByText("ずんだもんから返事が届きました")).toBe(causalStatus);
    expect(causalStatus).toHaveTextContent("ずんだもんから返事が届きました");
  });

  it("places the delivered cue immediately before its real assistant reply", () => {
    const timeline = [
      { id: "message-1", type: "message" as const, role: "user" as const, text: "こんにちは", createdAt: now, delivery: "sent" as const },
      { id: "reply-1:0", type: "message" as const, role: "assistant" as const, text: "こんにちは", createdAt: now, delivery: "sent" as const, replyGroupId: "reply-1", sequence: 0 as const },
    ];
    renderCue({ phase: "delivered", requestId: "message-1", replyGroupId: "reply-1" }, { timeline });

    const cue = screen.getByText("ずんだもんから返事が届きました");
    const reply = screen.getByText("こんにちは", { selector: ".chat-message.is-assistant p" });
    expect(cue.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("maps only the observed YUI lifecycle to the composer and delivered reply echo targets", () => {
    const pending = [
      { id: "message-1", type: "message" as const, role: "user" as const, text: "こんにちは", createdAt: now, delivery: "sending" as const },
    ];
    const received = renderCue({ phase: "received", requestId: "message-1" }, { timeline: pending });
    expect(received.container.querySelector(".composer-shell")).toHaveAttribute("data-prism-echo", "received");
    expect(received.container.querySelector(".chat-message[data-prism-echo]")).toBeNull();
    received.unmount();

    const waiting = renderCue({ phase: "waiting", requestId: "message-1" }, { timeline: pending });
    expect(waiting.container.querySelector(".composer-shell")).toHaveAttribute("data-prism-echo", "waiting");
    waiting.unmount();

    const deliveredTimeline = [
      { ...pending[0], delivery: "sent" as const },
      { id: "reply-1:0", type: "message" as const, role: "assistant" as const, text: "届いたよ", createdAt: now, delivery: "sent" as const, replyGroupId: "reply-1", sequence: 0 as const },
      { id: "reply-1:1", type: "message" as const, role: "assistant" as const, text: "続きだよ", createdAt: now, delivery: "sent" as const, replyGroupId: "reply-1", sequence: 1 as const },
    ];
    const delivered = renderCue({ phase: "delivered", requestId: "message-1", replyGroupId: "reply-1" }, { timeline: deliveredTimeline });
    expect(delivered.container.querySelector(".composer-shell")).not.toHaveAttribute("data-prism-echo");
    expect(screen.getByTestId("message-reply-1:0")).toHaveAttribute("data-prism-echo", "delivered");
    expect(screen.getByTestId("message-reply-1:1")).not.toHaveAttribute("data-prism-echo");
  });

  it("keeps Search and Minimal on their existing status instead of adding a YUI cue", () => {
    const searchPending = [{ id: "message-1", type: "message" as const, role: "user" as const, text: "最新情報を検索して", createdAt: now, delivery: "sending" as const }];
    const first = renderCue({ phase: "waiting", requestId: "message-1" }, { timeline: searchPending });
    expect(screen.getByRole("status", { name: "検索中" })).toBeInTheDocument();
    expect(screen.queryByText("ずんだもんが返事をつくっています")).not.toBeInTheDocument();
    expect(first.container.querySelector("[data-prism-echo]")).toBeNull();
    first.unmount();

    const ordinaryPending = [{ ...searchPending[0], text: "こんにちは" }];
    const minimal = renderCue({ phase: "waiting", requestId: "message-1" }, { style: "minimal", timeline: ordinaryPending });
    expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeInTheDocument();
    expect(screen.queryByText("ずんだもんが返事をつくっています")).not.toBeInTheDocument();
    expect(minimal.container.querySelector("[data-prism-echo]")).toBeNull();
  });

  it.each([
    ["feature OFF", { enabled: false }],
    ["call preparation", { callPreparing: true }],
    ["dictation", { dictationState: "recording" as const }],
  ])("keeps Prism Echo absent while %s has priority", (_label, options) => {
    const pending = [{ id: "message-1", type: "message" as const, role: "user" as const, text: "こんにちは", createdAt: now, delivery: "sending" as const }];
    const view = renderCue({ phase: "waiting", requestId: "message-1" }, { timeline: pending, ...options });

    expect(view.container.querySelector("[data-prism-echo]")).toBeNull();
  });

  it("renders no new cue for failure, dismissal, or malformed input", () => {
    const failed = [{ id: "message-1", type: "message" as const, role: "user" as const, text: "こんにちは", createdAt: now, delivery: "failed" as const }];
    const view = renderCue({ phase: "waiting", requestId: "message-1" }, { timeline: failed });
    expect(view.container.querySelector(".yui-state-cue")).toBeNull();
    expect(view.container.querySelector("[data-prism-echo]")).toBeNull();
    view.rerender(<Chat
      state={{ profile, openingRequestId: null, failureByMessageId: {}, snapshot: EMPTY_LOCAL_CHAT }}
      delayedGreetingReplyGroupId={null}
      onGreetingRevealed={vi.fn()}
      hydrating={false}
      persistenceWarning={false}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCall={vi.fn()}
      onOpenSettings={vi.fn()}
      causalCueEnabled
      causalCue={{ phase: "unknown", requestId: "message-1" } as never}
      visualStyle="yui"
    />);
    expect(view.container.querySelector(".yui-state-cue")).toBeNull();
  });

  it("keeps the handoff motion one-shot and does not use the active primary as cue body text", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.yui-state-cue\s*\{[^}]*animation:\s*yui-state-cue-enter 160ms ease-out both;/s);
    expect(styles).toMatch(/\.yui-state-cue\[data-phase="delivered"\]\s*\{[^}]*animation-duration:\s*140ms;/s);
    expect(styles).not.toMatch(/\.yui-state-cue\[data-phase="waiting"\][^{]*\{[^}]*color:\s*var\(--yui-state-cue-active\)/s);
  });
});
