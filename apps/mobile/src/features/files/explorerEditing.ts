/** Text-editing helpers for the explorer's editor, kept pure so they can be tested. */

export interface EditorSelection {
  readonly start: number;
  readonly end: number;
}

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeWord: boolean;
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Null when `query` is an invalid regular expression. */
export function findPattern(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null;
  const source = options.regex ? query : escapeRegex(query);
  try {
    return new RegExp(
      options.wholeWord ? `\\b(?:${source})\\b` : source,
      options.caseSensitive ? "g" : "gi",
    );
  } catch {
    return null;
  }
}

export function findMatches(text: string, pattern: RegExp | null, limit = 10_000) {
  if (pattern === null) return [];
  const matches: Array<EditorSelection> = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** The match at or after `from`, wrapping to the first; `backwards` finds the one before. */
export function nextMatchIndex(
  matches: ReadonlyArray<EditorSelection>,
  from: number,
  backwards: boolean,
) {
  if (matches.length === 0) return -1;
  if (backwards) {
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index]!.start < from) return index;
    }
    return matches.length - 1;
  }
  const index = matches.findIndex((match) => match.start >= from);
  return index === -1 ? 0 : index;
}

export function replaceAll(
  text: string,
  pattern: RegExp | null,
  replacement: string,
  regex: boolean,
) {
  if (pattern === null) return { text, count: 0 };
  const count = findMatches(text, pattern).length;
  pattern.lastIndex = 0;
  // A function replacement keeps "$1" literal outside regex mode.
  return {
    text: regex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement),
    count,
  };
}

export function lineColumn(text: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function lineOffset(text: string, line: number) {
  let current = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (current >= line) return index;
    if (text.charCodeAt(index) === 10) current += 1;
  }
  return text.length;
}

export function countLines(text: string) {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) lines += 1;
  return lines;
}

export function insertAt(text: string, selection: EditorSelection, insert: string) {
  return {
    text: text.slice(0, selection.start) + insert + text.slice(selection.end),
    selection: { start: selection.start + insert.length, end: selection.start + insert.length },
  };
}

/** Undo history that coalesces typing into one step per pause or word. */
export interface EditorHistory {
  readonly past: ReadonlyArray<string>;
  readonly future: ReadonlyArray<string>;
  readonly lastPushAt: number;
}

export const EMPTY_HISTORY: EditorHistory = { past: [], future: [], lastPushAt: 0 };
const HISTORY_LIMIT = 200;
const COALESCE_MS = 800;

export function recordEdit(history: EditorHistory, previous: string, next: string, now: number) {
  const wordBreak = /\s$/.test(next) && !/\s$/.test(previous);
  if (now - history.lastPushAt < COALESCE_MS && !wordBreak && history.past.length > 0) {
    return { ...history, future: [], lastPushAt: now };
  }
  return { past: [...history.past, previous].slice(-HISTORY_LIMIT), future: [], lastPushAt: now };
}

export function undo(history: EditorHistory, current: string) {
  const previous = history.past.at(-1);
  if (previous === undefined) return null;
  return {
    text: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
      lastPushAt: 0,
    },
  };
}

export function redo(history: EditorHistory, current: string) {
  const next = history.future[0];
  if (next === undefined) return null;
  return {
    text: next,
    history: { past: [...history.past, current], future: history.future.slice(1), lastPushAt: 0 },
  };
}

/** Hex dump rows of 16 bytes: offset, hex pairs and printable ASCII. */
export function hexRows(bytes: Uint8Array, startOffset: number) {
  const rows: Array<string> = [];
  for (let row = 0; row < bytes.length; row += 16) {
    const chunk = bytes.subarray(row, row + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (byte) =>
      byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".",
    ).join("");
    rows.push(
      `${(startOffset + row).toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`,
    );
  }
  return rows;
}
