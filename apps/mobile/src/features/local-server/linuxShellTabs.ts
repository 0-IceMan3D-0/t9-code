import type { LinuxShellInfo } from "./localServerModule";

const MAX_TITLE = 18;

const shorten = (text: string) =>
  text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;

// Ubuntu's bashrc titles the window "user@host: folder" at every prompt.
const PROMPT_TITLE = /^[^@\s]+@[^:\s]+: (.+)$/;

function folderName(folder: string): string {
  if (folder === "~" || folder === "/") return folder;
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || folder;
}

/** A running program's name and first arguments, else the folder or title the shell reports. */
export function shellTabTitle(info: LinuxShellInfo | undefined): string {
  if (!info) return "bash";
  if (info.busy && info.command) {
    const [program = "", ...rest] = info.command.split(" ");
    return shorten([program.slice(program.lastIndexOf("/") + 1), ...rest].join(" "));
  }
  const title = info.title?.trim();
  if (!title) return "bash";
  const folder = PROMPT_TITLE.exec(title)?.[1];
  return shorten(folder ? folderName(folder) : title);
}

/** The tab to show after `closedId` goes away: the one before it, else the next. */
export function tabAfterClose(
  ids: ReadonlyArray<string>,
  closedId: string,
  activeId: string | null,
): string | null {
  if (activeId !== closedId && activeId !== null && ids.includes(activeId)) return activeId;
  const index = ids.indexOf(closedId);
  const rest = ids.filter((id) => id !== closedId);
  if (rest.length === 0) return null;
  return rest[Math.max(0, Math.min(index - 1, rest.length - 1))] ?? null;
}
