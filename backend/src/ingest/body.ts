import type { PageEdges } from '../ai/types.js';
import { normalizeLine } from '../lib/text.js';

/** Number of non-empty lines at the top and bottom of each page that may be header/footer. */
export const EDGE_LINES = 4;
const MAX_EDGE_PAGES = 30;

const PAGE_NUMBER = [
  /^(page|pagina|seite|blz\.?|p\.?)?\s*#(\s*(of|\/|van|von|de)\s*#)?$/,
  /^[-–—]\s*#\s*[-–—]$/,
  /^[ivxlc]+$/,
];

function nonEmptyIndexes(lines: string[]): number[] {
  return lines.flatMap((l, i) => (l.trim() ? [i] : []));
}

/** First/last EDGE_LINES non-empty lines for up to MAX_EDGE_PAGES pages, sampled evenly. */
export function pageEdges(pages: string[][]): PageEdges[] {
  const count = Math.min(pages.length, MAX_EDGE_PAGES);
  const picks = new Set<number>();
  for (let i = 0; i < count; i++) picks.add(Math.round((i * (pages.length - 1)) / Math.max(count - 1, 1)));
  return [...picks].map((p) => {
    const idx = nonEmptyIndexes(pages[p]);
    const top = idx.slice(0, EDGE_LINES).map((i) => pages[p][i].trim());
    const bottom = idx.length > EDGE_LINES ? idx.slice(-EDGE_LINES).map((i) => pages[p][i].trim()) : [];
    return { page: p + 1, top, bottom };
  });
}

/** Heuristic fallback: edge lines that repeat (after normalizing digits) on many pages. */
export function detectRepeatedEdgeLines(edges: PageEdges[]): string[] {
  if (edges.length < 3) return [];
  const threshold = Math.max(2, Math.ceil(edges.length * 0.4));
  const counts = new Map<string, { n: number; example: string }>();
  for (const e of edges) {
    for (const line of new Set([...e.top, ...e.bottom])) {
      const key = normalizeLine(line);
      const entry = counts.get(key) ?? { n: 0, example: line };
      entry.n++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].filter((c) => c.n >= threshold).map((c) => c.example);
}

export function isPageNumber(line: string): boolean {
  const n = normalizeLine(line);
  return n.length > 0 && PAGE_NUMBER.some((re) => re.test(n));
}

/**
 * Removes header/footer lines from the top and bottom edge of every page.
 * A line is removed when it matches one of the identified header/footer lines (digits normalized, so
 * "Page 3 of 10" matches "Page 7 of 10") or looks like a bare page number.
 */
export function removeHeaderFooter(pages: string[][], headerFooterLines: string[]): { body: string; removed: number } {
  const patterns = new Set(headerFooterLines.map(normalizeLine).filter(Boolean));
  let removed = 0;
  const cleaned = pages.map((lines) => {
    const idx = nonEmptyIndexes(lines);
    const edge = new Set([...idx.slice(0, EDGE_LINES), ...idx.slice(-EDGE_LINES)]);
    return lines
      .filter((line, i) => {
        if (!edge.has(i)) return true;
        const drop = patterns.has(normalizeLine(line)) || isPageNumber(line);
        if (drop) removed++;
        return !drop;
      })
      .join('\n');
  });
  const body = cleaned
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, removed };
}
