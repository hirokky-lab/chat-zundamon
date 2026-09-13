export type ChatFollowState = {
  following: boolean;
  hasUnreadReply: boolean;
  suspendedBySearch: boolean;
};

export type ChatFollowAction =
  | { type: "user-scrolled"; distanceFromBottom: number }
  | { type: "assistant-bubble-visible" }
  | { type: "jump-to-latest" }
  | { type: "search-opened" }
  | { type: "search-closed"; distanceFromBottom: number };

const BOTTOM_THRESHOLD_PX = 96;

export function reduceChatFollow(
  state: ChatFollowState,
  action: ChatFollowAction,
): ChatFollowState {
  switch (action.type) {
    case "user-scrolled":
      if (state.suspendedBySearch) return state;
      return action.distanceFromBottom <= BOTTOM_THRESHOLD_PX
        ? { following: true, hasUnreadReply: false, suspendedBySearch: false }
        : { ...state, following: false };
    case "assistant-bubble-visible":
      return state.following ? state : { ...state, hasUnreadReply: true };
    case "jump-to-latest":
      return { following: true, hasUnreadReply: false, suspendedBySearch: false };
    case "search-opened":
      return { ...state, following: false, suspendedBySearch: true };
    case "search-closed":
      return action.distanceFromBottom <= BOTTOM_THRESHOLD_PX
        ? { following: true, hasUnreadReply: false, suspendedBySearch: false }
        : { ...state, following: false, suspendedBySearch: false };
  }
}
