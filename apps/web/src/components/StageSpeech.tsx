import type { StageLink } from '../stage-dialogue';
import { useLayoutEffect, useRef } from 'react';
import { speechSegments } from '../speech-segments';

export function StageSpeech({ text, links = [], thinking = false }: { text: string; links?: StageLink[]; thinking?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const following = useRef(true);
  const fitViewport = useRef<(() => void) | null>(null);
  const previousText = useRef('');
  const segments = speechSegments(text);
  const parts = segments.map((text, index) => ({ text, id: `${index}:${text}` }));
  useLayoutEffect(() => {
    const pane = viewport.current;
    const content = stack.current;
    const freshReply = thinking || !text.startsWith(previousText.current);
    previousText.current = thinking ? '' : text;
    if (freshReply) { following.current = true; positions.current.clear(); }
    if (!pane || !content) return;
    const bubbles = Array.from(content.querySelectorAll<HTMLElement>('[data-speech-id]'));
    const fit = () => {
      // Freeze the reading window while browsing older parts of this reply.
      if (!following.current) return;
      const lastTwo = bubbles.slice(-2);
      const gap = parseFloat(getComputedStyle(content).rowGap) || 0;
      pane.style.height = `${lastTwo.reduce((sum, node) => sum + node.offsetHeight, 0) + Math.max(0, lastTwo.length - 1) * gap}px`;
      pane.scrollTop = content.offsetHeight - pane.clientHeight;
    };
    fitViewport.current = fit;
    fit();
    const next = new Map<string, number>();
    const animations: Animation[] = [];
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const element of bubbles) {
      const id = element.dataset.speechId!;
      const top = element.getBoundingClientRect().top;
      const previous = positions.current.get(id);
      next.set(id, top);
      if (following.current && !reduced && element.animate && element.getClientRects().length) {
        animations.push(element.animate([
          { transform: `translateY(${previous === undefined ? 22 : previous - top}px)`, opacity: previous === undefined ? 0 : 1 },
          { transform: 'translateY(0)', opacity: 1 },
        ], { duration: 320, easing: 'cubic-bezier(.22,.68,0,1)' }));
      }
    }
    positions.current = next;
    // Keep two complete bubbles after font loading, resizing and keyboard changes.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(content);
    observer?.observe(pane);
    return () => { fitViewport.current = null; observer?.disconnect(); animations.forEach(animation => animation.cancel()); };
  }, [text, thinking]);
  if (thinking) return <div className="stage-speech"><p className="stage-thinking" role="status" aria-label="ずんだもんが考え中"><span aria-hidden="true">・</span><span aria-hidden="true">・</span><span aria-hidden="true">・</span></p></div>;
  if (!text) return null;
  return <div className="stage-speech">
    <div className="stage-speech-viewport" ref={viewport} tabIndex={0} role="region" aria-label="今回の返答を上下にスクロール"
      onScroll={event => {
        const pane = event.currentTarget;
        const wasFollowing = following.current;
        // Transforms can temporarily extend scrollHeight during the entrance animation.
        following.current = (stack.current?.offsetHeight ?? pane.scrollHeight) - pane.scrollTop - pane.clientHeight < 8;
        if (!wasFollowing && following.current) fitViewport.current?.();
      }}
      onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
    <div className="stage-speech-stack" ref={stack} aria-label="ずんだもんのセリフ">
      {parts.map((part, index) => <div className={`stage-speech-bubble${index === parts.length - 1 ? ' is-current' : ''}`} key={part.id} data-speech-id={part.id}><p>{part.text}</p></div>)}
    </div>
    </div>
    {links.length ? <div className="stage-speech-links" aria-label="返答のリンク">{links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}</div> : null}
  </div>;
}
