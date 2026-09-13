import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StageSpeech } from '../src/components/StageSpeech';
import { speechSegments } from '../src/speech-segments';
it('preserves text and prefers sentence boundaries', () => {
 const text = '長い説明なのだ。'.repeat(50);
 const pages = speechSegments(text);
 expect(pages.join('')).toBe(text);
 expect(pages.every(page => page.endsWith('。'))).toBe(true);
});
it('does not split a kanji compound at the length boundary', () => {
 const text = 'これは量子力学の基本方程式について説明している文章です。';
 const pages = speechSegments(text, 6);
 expect(pages.join('')).toBe(text);
 expect(pages.some(page => page.includes('量子力学'))).toBe(true);
 expect(pages.some(page => page.includes('基本方程式'))).toBe(true);
 expect(pages.every(page => !/^[、。]/.test(page))).toBe(true);
});
it('retains all segments of only the current reply for vertical review', () => {
 const { rerender } = render(<StageSpeech text="ひとつめなのだ。" />);
 rerender(<StageSpeech text={"ひとつめなのだ。\n\nふたつめなのだ。"} />);
 expect(screen.getByText('ひとつめなのだ。')).toBeVisible();
 expect(screen.getByText('ふたつめなのだ。')).toBeVisible();
 rerender(<StageSpeech text={"ひとつめなのだ。\n\nふたつめなのだ。\n\nみっつめなのだ。\n\nよっつめなのだ。"} />);
 expect(screen.getByText('ひとつめなのだ。')).toBeInTheDocument();
 expect(screen.getByLabelText('ずんだもんのセリフ').children).toHaveLength(4);
 expect(screen.getByText('よっつめなのだ。').parentElement).toHaveClass('is-current');
 expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
 rerender(<StageSpeech text="新しい返事なのだ。" />);
 expect(screen.queryByText('よっつめなのだ。')).not.toBeInTheDocument();
 expect(screen.getByText('新しい返事なのだ。')).toBeVisible();
});

it('renders response links beside the speech without navigating automatically', () => {
 render(<StageSpeech text="見つかったのだ。" links={[{label:'説明動画',url:'https://drive.google.com/file/d/example/view'}]} />);
 expect(screen.getByRole('link', {name:'説明動画 ↗'})).toHaveAttribute('href','https://drive.google.com/file/d/example/view');
});

it('holds new text behind dots until speech is ready',()=>{
 const {rerender}=render(<StageSpeech text="新しい返答" thinking />);
 expect(screen.getByRole('status',{name:'ずんだもんが考え中'})).toBeVisible();
 expect(screen.queryByText('新しい返答')).not.toBeInTheDocument();
 rerender(<StageSpeech text="新しい返答" />);expect(screen.getByText('新しい返答')).toBeVisible();
});
