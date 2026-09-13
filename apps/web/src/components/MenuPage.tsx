import { ArrowLeft, X } from '@phosphor-icons/react';
import { createContext, useContext, useEffect, useId, useRef, type Ref, type ReactNode } from 'react';
import './menu-page.css';

export const MenuHomeContext = createContext<(() => void) | null>(null);

/** Shared room backdrop, navigation and scroll surface for menu destinations. */
export function MenuPage({ title, onBack, backLabel = 'メニューへ戻る', busy = false, action, children, contentClassName = '', backRef, hideBack = false }: {
  hideBack?: boolean; backRef?: Ref<HTMLButtonElement>; title: string; onBack: () => void; backLabel?: string; busy?: boolean;
  action?: ReactNode; children: ReactNode; contentClassName?: string;
}) {
  const closeHome = useContext(MenuHomeContext) ?? onBack;
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="menu-page-backdrop">
    <section ref={panel} className="menu-page" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onBack(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? []).filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className={`menu-page-header${hideBack ? " without-back" : ""}`}>
        {!hideBack ? <button ref={backRef} type="button" aria-label={backLabel} disabled={busy} onClick={onBack}><ArrowLeft size={24} aria-hidden="true" /></button> : null}
        <h1 id={id} ref={heading} tabIndex={-1}>{title}</h1>
        <div className="menu-page-action">{action}{closeHome ? <button className="menu-page-close" type="button" aria-label="閉じてホームへ戻る" disabled={busy} onClick={closeHome}><X size={24} aria-hidden="true" /></button> : null}</div>
      </header>
      <div className={`menu-page-content ${contentClassName}`}>{children}</div>
    </section>
  </div>;
}
