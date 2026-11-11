// Finding a board: by vendor, and by a search over vendor, board name,
// board id and SoC. Pure logic for the Board step; tested in
// test/boardsearch.test.ts.

export interface Searchable {
  board: string;
  boardName: string;
  vendor: string;
  soc: string;
}

/** Lower case, without spaces, hyphens, dots or underscores: "ROCK-4D" and "rock 4d" become "rock4d". */
export function squash(s: string): string {
  return s.toLowerCase().replace(/[\s\-._]+/g, '');
}

/** The query's words; empty when there is nothing to search for. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).map(squash).filter(Boolean);
}

/**
 * Does the board match? Every word must be found somewhere in the board's
 * text, in any order. The whole query squashed together also counts, so
 * "rock 4d" finds "ROCK 4D" even though "4d" alone would too.
 */
export function matches(b: Searchable, q: string): boolean {
  const words = queryWords(q);
  if (words.length === 0) return true;
  const fields = [b.vendor, b.boardName, b.board, b.soc].map(squash);
  const hay = fields.join('|');
  if (hay.includes(squash(q))) return true;
  return words.every((w) => fields.some((f) => f.includes(w)));
}

export interface VendorCount {
  vendor: string;
  /** Boards of this vendor, or matches while searching. */
  count: number;
}

/** Vendors A to Z with their counts (matches when q is set). */
export function vendorCounts(boards: Searchable[], q = ''): VendorCount[] {
  const map = new Map<string, number>();
  for (const b of boards) {
    if (!map.has(b.vendor)) map.set(b.vendor, 0);
    if (matches(b, q)) map.set(b.vendor, map.get(b.vendor)! + 1);
  }
  return [...map.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' }));
}

/**
 * The boards to show. A search spans all vendors, whatever vendor is
 * selected; without a search the selected vendor filters (null is all).
 */
export function visibleBoards<T extends Searchable>(boards: T[], vendor: string | null, q: string): T[] {
  if (queryWords(q).length > 0) return boards.filter((b) => matches(b, q));
  return vendor === null ? boards : boards.filter((b) => b.vendor === vendor);
}

export const BOARD_REQUEST_URL = 'https://github.com/roxora-os/build/issues/new?template=board_request.yml';
