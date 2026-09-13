export class StreamingSentenceBuffer {
  private pending = "";
  push(delta: string): string[] { this.pending += delta; return this.extract(false); }
  finish(): string[] { return this.extract(true); }
  reset(): void { this.pending = ""; }
  private extract(flush: boolean): string[] {
    const chunks: string[] = []; const endings = new Set(["。", "！", "？", "!", "?"]); const closers = new Set(["」", "』", "）", "】", "”", "’"]);
    while (this.pending) { const chars = [...this.pending]; let boundary = -1; const scanLimit = Math.min(chars.length, 160);
      for (let index = 0; index < scanLimit; index += 1) { if (!endings.has(chars[index]!)) continue; boundary = index + 1; while (boundary < scanLimit && closers.has(chars[boundary]!)) boundary += 1; break; }
      if (boundary < 0 && chars.length > 120) { const candidates = chars.slice(60, 120); const comma = Math.max(candidates.lastIndexOf("、"), candidates.lastIndexOf("，"), candidates.lastIndexOf(",")); boundary = comma >= 0 ? 60 + comma + 1 : 120; }
      if (boundary < 0) break; const chunk = chars.slice(0, boundary).join("").trim(); this.pending = chars.slice(boundary).join(""); if (chunk) chunks.push(chunk); }
    if (flush) { const remainder = this.pending.trim(); this.pending = ""; if (remainder) chunks.push(remainder); } return chunks;
  }
}
