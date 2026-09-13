import { describe, expect, it } from "vitest";
import { applyChatOverlayInsets } from "../src/chat-overlays";

describe("chat overlay insets", () => {
  it("writes measured overlay heights to the chat root", () => {
    const root = document.createElement("main");

    applyChatOverlayInsets(root, 84.5, 112.25);

    expect(root.style.getPropertyValue("--chat-header-height")).toBe("84.5px");
    expect(root.style.getPropertyValue("--chat-composer-height")).toBe("112.25px");
  });
});
