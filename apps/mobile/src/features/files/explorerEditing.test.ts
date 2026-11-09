import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_HISTORY,
  findMatches,
  findPattern,
  hexRows,
  lineColumn,
  lineOffset,
  nextMatchIndex,
  recordEdit,
  redo,
  replaceAll,
  undo,
} from "./explorerEditing";

const plain = { caseSensitive: false, regex: false, wholeWord: false };

describe("explorerEditing", () => {
  it("finds literal, whole-word and regex matches and wraps around", () => {
    const text = "foo.bar foobar Foo";
    expect(findMatches(text, findPattern("foo", plain))).toHaveLength(3);
    expect(findMatches(text, findPattern("foo", { ...plain, wholeWord: true }))).toHaveLength(2);
    expect(findMatches(text, findPattern(".", plain))).toEqual([{ start: 3, end: 4 }]);
    expect(findPattern("(", { ...plain, regex: true })).toBeNull();
    const matches = findMatches(text, findPattern("foo", plain));
    expect(nextMatchIndex(matches, 16, false)).toBe(0);
    expect(nextMatchIndex(matches, 0, true)).toBe(2);
  });

  it("replaces with regex groups only in regex mode", () => {
    const pattern = findPattern("(a)(b)", { ...plain, regex: true });
    expect(replaceAll("ab ab", pattern, "$2$1", true)).toEqual({ text: "ba ba", count: 2 });
    expect(replaceAll("a.b", findPattern(".", plain), "$&", false)).toEqual({
      text: "a$&b",
      count: 1,
    });
  });

  it("maps offsets to lines and back", () => {
    const text = "one\ntwo\nthree";
    expect(lineColumn(text, 5)).toEqual({ line: 2, column: 2 });
    expect(lineOffset(text, 3)).toBe(8);
    expect(lineOffset(text, 99)).toBe(text.length);
  });

  it("coalesces quick typing into one undo step and redoes it", () => {
    let history = recordEdit(EMPTY_HISTORY, "", "a", 1000);
    history = recordEdit(history, "a", "ab", 1100);
    expect(history.past).toEqual([""]);
    history = recordEdit(history, "ab", "ab ", 1200);
    expect(history.past).toEqual(["", "ab"]);
    const undone = undo(history, "ab ");
    expect(undone?.text).toBe("ab");
    expect(redo(undone!.history, "ab")?.text).toBe("ab ");
  });

  it("dumps bytes as hex rows", () => {
    expect(hexRows(new Uint8Array([0x48, 0x69, 0x00]), 16)).toEqual([
      `00000010  48 69 00${" ".repeat(39)}  Hi.`,
    ]);
  });
});
