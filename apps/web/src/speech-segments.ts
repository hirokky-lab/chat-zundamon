/** Shared display and synthesis boundaries; preserve words and sentence endings. */
export function speechSegments(text: string, limit = 90): string[] {
  const paragraphs = text.split(/\n+/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.flatMap(part => speechSegments(part, limit));
  const normalized = paragraphs[0] ?? '';
  const pages: string[] = [];
  let page = '';
  const size = (value: string) => Array.from(value).length;
  // Prefer complete sentences. Long sentences wrap at Japanese word boundaries.
  const sentences = new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(normalized);
  for (const { segment: sentence } of sentences) {
    if (page && size(page + sentence) > limit) { pages.push(page); page = ''; }
    if (size(sentence) <= limit) { page += sentence; continue; }
    const words = Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(sentence), entry => entry.segment);
    for (const word of words) {
      const joinedKanji = /[\p{Script=Han}々]$/u.test(page) && /^[\p{Script=Han}々]/u.test(word);
      const trailingMark = /^[、。！？!?）」』】\s]/u.test(word);
      if (page && size(page + word) > limit && !joinedKanji && !trailingMark) {
        pages.push(page); page = '';
      }
      page += word;
    }
  }
  if (page) pages.push(page);
  return pages;
}
