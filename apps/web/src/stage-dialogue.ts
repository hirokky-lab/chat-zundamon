import { lifeMapsUrl, type TimelineItem } from '@yui/domain';

/** Keep all visible parts of the current response together on the character stage. */
export function stageDialogue(timeline: readonly TimelineItem[]): string {
  let last = -1;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type === 'message' && item.role === 'assistant') { last = index; break; }
  }
  if (last < 0) return '';
  const latest = timeline[last];
  if (latest.type !== 'message' || latest.role !== 'assistant') return '';
  const parts: string[] = [];
  for (let index = last; index >= 0; index--) {
    const item = timeline[index];
    if (item.type !== 'message') break;
    if (item.role !== 'assistant' || item.replyGroupId !== latest.replyGroupId) break;
    parts.unshift(item.text);
  }
  return parts.join('\n\n');
}

export type StageLink = { label: string; url: string };
/** Only expose links belonging to the currently displayed response. */
export function stageLinks(timeline: readonly TimelineItem[]): StageLink[] {
  let last = -1;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type === 'message' && item.role === 'assistant') { last = index; break; }
  }
  const latest = timeline[last];
  if (!latest || latest.type !== 'message' || latest.role !== 'assistant') return [];
  const links: StageLink[] = [];
  for (let index = last; index >= 0; index--) {
    const item = timeline[index];
    if (item.type !== 'message' || item.role !== 'assistant' || item.replyGroupId !== latest.replyGroupId) break;
    const card = item.lifeCard;
    const files = card?.kind === 'drive-results' ? card.result.files : card?.kind === 'drive-content' ? [card.content.file] : [];
    for (const file of files) links.push({ label: file.name, url: `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` });
    if (card?.kind === 'maps') links.push({ label: `${card.destination}への道順`, url: lifeMapsUrl(card) });
    if (item.search?.status === 'completed') links.push(...item.search.sources.map(source => ({ label: source.title, url: source.url })));
  }
  return links.filter((link, index) => /^https?:\/\//.test(link.url) && links.findIndex(other => other.url === link.url) === index);
}
