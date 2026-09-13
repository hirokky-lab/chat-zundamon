import { describe, expect, it } from "vitest";
import { reduceChatFollow } from "../src/chat-follow";

describe("chat follow state", () => {
  it("stops following only after scrolling more than 96px from the bottom", () => {
    expect(reduceChatFollow(
      { following: true, hasUnreadReply: false, suspendedBySearch: false },
      { type: "user-scrolled", distanceFromBottom: 96 },
    )).toEqual({ following: true, hasUnreadReply: false, suspendedBySearch: false });
    expect(reduceChatFollow(
      { following: true, hasUnreadReply: false, suspendedBySearch: false },
      { type: "user-scrolled", distanceFromBottom: 97 },
    )).toEqual({ following: false, hasUnreadReply: false, suspendedBySearch: false });
  });

  it("returns to following when the user manually reaches the bottom", () => {
    expect(reduceChatFollow(
      { following: false, hasUnreadReply: true, suspendedBySearch: false },
      { type: "user-scrolled", distanceFromBottom: 0 },
    )).toEqual({ following: true, hasUnreadReply: false, suspendedBySearch: false });
  });

  it("retains a single unread state for every visible assistant bubble while not following", () => {
    const first = reduceChatFollow(
      { following: false, hasUnreadReply: false, suspendedBySearch: false },
      { type: "assistant-bubble-visible" },
    );
    expect(first).toEqual({ following: false, hasUnreadReply: true, suspendedBySearch: false });
    expect(reduceChatFollow(first, { type: "assistant-bubble-visible" })).toEqual(first);
  });

  it("suspends follow during search and resumes after jumping to the latest reply", () => {
    const searching = reduceChatFollow(
      { following: true, hasUnreadReply: false, suspendedBySearch: false },
      { type: "search-opened" },
    );
    expect(searching).toEqual({ following: false, hasUnreadReply: false, suspendedBySearch: true });
    expect(reduceChatFollow(
      { following: false, hasUnreadReply: true, suspendedBySearch: true },
      { type: "jump-to-latest" },
    )).toEqual({ following: true, hasUnreadReply: false, suspendedBySearch: false });
  });

  it("keeps search suspension when a scroll event reaches the bottom", () => {
    expect(reduceChatFollow(
      { following: false, hasUnreadReply: false, suspendedBySearch: true },
      { type: "user-scrolled", distanceFromBottom: 0 },
    )).toEqual({ following: false, hasUnreadReply: false, suspendedBySearch: true });
  });

  it("settles search suspension from the current distance when search closes", () => {
    expect(reduceChatFollow(
      { following: false, hasUnreadReply: false, suspendedBySearch: true },
      { type: "search-closed", distanceFromBottom: 97 },
    )).toEqual({ following: false, hasUnreadReply: false, suspendedBySearch: false });
    expect(reduceChatFollow(
      { following: false, hasUnreadReply: true, suspendedBySearch: true },
      { type: "search-closed", distanceFromBottom: 96 },
    )).toEqual({ following: true, hasUnreadReply: false, suspendedBySearch: false });
  });
});
