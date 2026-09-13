import type { TimelineItem } from "@yui/domain";

export type HistorySearchResult = {
  messageId: string;
  timelineIndex: number;
};

const normalizeSearchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ja-JP");

export function searchChatHistory(
  timeline: TimelineItem[],
  query: string,
): HistorySearchResult[] {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return [];

  return timeline.flatMap((item, timelineIndex) =>
    item.type === "message" &&
    item.flow !== "profile" &&
    normalizeSearchText(item.text).includes(normalizedQuery)
      ? [{ messageId: item.id, timelineIndex }]
      : [],
  );
}

export function selectInitialResult(
  results: HistorySearchResult[],
  anchorMessageId: string | null,
  timeline: TimelineItem[],
): number | null {
  if (results.length === 0) return null;

  const anchorIndex = anchorMessageId === null
    ? -1
    : timeline.findIndex((item) => item.id === anchorMessageId);
  if (anchorIndex < 0) return results.length - 1;

  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index].timelineIndex <= anchorIndex) return index;
  }
  return results.length - 1;
}
