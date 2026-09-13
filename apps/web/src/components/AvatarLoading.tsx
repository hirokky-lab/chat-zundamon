import type { CSSProperties } from 'react';
import './avatar-loading.css';

export function AvatarLoading({ label = 'キャラクターを読み込み中…' }: { label?: string }) {
  return <figcaption className="avatar-loading" role="status" aria-label={label}>
    <span className="avatar-loading-dots" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => <span key={index} style={{ '--dot-index': index } as CSSProperties} />)}
    </span>
    <span className="avatar-loading-label">{label}</span>
  </figcaption>;
}
