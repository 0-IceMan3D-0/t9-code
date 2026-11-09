import { describe, expect, it } from "vite-plus/test";

import { explorerBreadcrumbs, explorerCopyName, sortExplorerEntries } from "./explorerPath";

describe("explorerPath", () => {
  it("splits POSIX and Windows paths into breadcrumbs", () => {
    expect(explorerBreadcrumbs("/home/t3/src", "/").map((crumb) => crumb.path)).toEqual([
      "/",
      "/home",
      "/home/t3",
      "/home/t3/src",
    ]);
    expect(explorerBreadcrumbs("C:\\Users\\me", "\\").map((crumb) => crumb.path)).toEqual([
      "C:\\",
      "C:\\Users",
      "C:\\Users\\me",
    ]);
  });

  it("names copies after the first free slot", () => {
    expect(explorerCopyName("a.txt", new Set(["a.txt", "a copy.txt"]))).toBe("a copy 2.txt");
    expect(explorerCopyName(".env", new Set())).toBe(".env copy");
  });

  it("lists folders first and hides dotfiles unless asked", () => {
    const entries = [
      { name: "b.txt", kind: "file", symlink: false, byteLength: 5 },
      { name: ".hidden", kind: "file", symlink: false, byteLength: 1 },
      { name: "src", kind: "directory", symlink: false },
      { name: "a10.txt", kind: "file", symlink: false, byteLength: 50 },
      { name: "a9.txt", kind: "file", symlink: false, byteLength: 9 },
    ] as const;
    const names = (sort: "name" | "size", showHidden: boolean) =>
      sortExplorerEntries(entries, { sort, showHidden, filter: "" }).map((entry) => entry.name);
    expect(names("name", false)).toEqual(["src", "a9.txt", "a10.txt", "b.txt"]);
    expect(names("size", true)).toEqual(["src", "a10.txt", "a9.txt", "b.txt", ".hidden"]);
  });
});
