import type { FilesystemDirectoryEntry } from "@t3tools/contracts";

export type ExplorerSeparator = "/" | "\\";
export type ExplorerSort = "name" | "size" | "modified";

export function joinExplorerPath(directory: string, name: string, separator: ExplorerSeparator) {
  return directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`;
}

export function explorerBasename(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || path;
}

/** Each ancestor of an absolute path, root first, for the breadcrumb bar. */
export function explorerBreadcrumbs(path: string, separator: ExplorerSeparator) {
  const parts = path.split(separator).filter((part) => part.length > 0);
  // POSIX roots are "/", Windows roots are a drive such as "C:\".
  const root = separator === "/" ? "/" : `${parts.shift() ?? ""}\\`;
  const crumbs = [{ label: root, path: root }];
  let current = root;
  for (const part of parts) {
    current = joinExplorerPath(current, part, separator);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** A name for a copy that does not clash with the listing: "a.txt" becomes "a copy.txt". */
export function explorerCopyName(name: string, taken: ReadonlySet<string>) {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let index = 1; ; index += 1) {
    const candidate = `${stem} copy${index === 1 ? "" : ` ${index}`}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function sortExplorerEntries(
  entries: ReadonlyArray<FilesystemDirectoryEntry>,
  input: { readonly sort: ExplorerSort; readonly showHidden: boolean; readonly filter: string },
) {
  const filter = input.filter.trim().toLowerCase();
  const compare = (left: FilesystemDirectoryEntry, right: FilesystemDirectoryEntry) => {
    if (input.sort === "size") return (right.byteLength ?? 0) - (left.byteLength ?? 0);
    if (input.sort === "modified") return (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0);
    return 0;
  };
  return entries
    .filter((entry) => input.showHidden || !entry.name.startsWith("."))
    .filter((entry) => filter.length === 0 || entry.name.toLowerCase().includes(filter))
    .sort(
      (left, right) =>
        Number(right.kind === "directory") - Number(left.kind === "directory") ||
        compare(left, right) ||
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    );
}
