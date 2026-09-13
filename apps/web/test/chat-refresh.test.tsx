import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat, type ChatProps } from "../src/screens/Chat";
import { EMPTY_LOCAL_CHAT } from "../src/local-state";

const props: ChatProps = {
  state: { profile: null, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT } },
  delayedGreetingReplyGroupId: null, onGreetingRevealed: vi.fn(),
  hydrating: false, persistenceWarning: false, suppressComposerAutofocus: true,
  onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn(),
};
function readHistory() {
  fireEvent.click(screen.getByRole("button", { name: "トークを開く" }));
  const area = screen.getByTestId("chat-scroll-area");
  Object.defineProperties(area, {
    scrollHeight: { configurable: true, value: 1600 },
    clientHeight: { configurable: true, value: 700 },
    scrollTop: { configurable: true, writable: true, value: 250 },
  });
  fireEvent.scroll(area);
  return area;
}
describe("chat composer while reading history", () => {
  it("slides empty input away while reading and restores it at latest", () => {
    render(<Chat {...props} />);
    const area = readHistory();
    expect(document.querySelector(".chat-bottom-stack")).toHaveClass("is-slid-away");
    expect(area.scrollTop).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: "最新のメッセージへ移動" }));
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  });
  it("keeps even whitespace drafts visible when reading history", () => {
    render(<Chat {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "メッセージ" }), { target: { value: " \n" } });
    readHistory();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toHaveValue(" \n");
    expect(screen.queryByRole("button", { name: "メッセージを書く" })).toBeNull();
  });
  it.each<Partial<ChatProps>>([
    { photoPreview: { url: "blob:fixture", byteSize: 12 } },
    { photoInputBusy: true }, { dictationState: "recording" }, { dictationState: "transcribing" },
  ])("keeps active photo and voice controls expanded: %j", (active) => {
    render(<Chat {...props} {...active} />);
    readHistory();
    expect(screen.queryByRole("button", { name: "メッセージを書く" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  });
});
