/** Catalog metadata only. Audio is installed separately on the owner's server. */
export const BGM_TRACKS = [
  { id: 'hiru', title: '昼下がり気分', author: 'KK', url: 'https://dova-s.jp/bgm/detail/4695' },
  { id: 'kaeru', title: 'かえるのピアノ', author: 'こおろぎ', url: 'https://dova-s.jp/bgm/detail/568' },
  { id: 'jitaku', title: '自宅にて', author: 'KK', url: 'https://dova-s.jp/bgm/detail/4041' },
] as const;
export type BgmTrack = typeof BGM_TRACKS[number]['id'];
export function isBgmTrack(value: unknown): value is BgmTrack {
  return BGM_TRACKS.some(track => track.id === value);
}
