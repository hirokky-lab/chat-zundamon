export function applyChatOverlayInsets(
  root: HTMLElement,
  headerPx: number,
  composerPx: number,
): void {
  root.style.setProperty("--chat-header-height", `${headerPx}px`);
  root.style.setProperty("--chat-composer-height", `${composerPx}px`);
}
