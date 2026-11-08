import { useSyncExternalStore } from "react";

import { localServer, type DevServerListener } from "./localServerModule";

export interface DevServer {
  /** Stable while the same process keeps listening on the port. */
  readonly key: string;
  readonly port: number;
  readonly url: string;
  /** host:port as shown to the user. */
  readonly address: string;
  /** The page's <title> once loaded, else a guess from the command. */
  readonly title: string;
  readonly command: string;
}

const KNOWN_SERVERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnext(-server|\b.*\bdev\b)/, "Next.js"],
  [/\bnux[ti]\b/, "Nuxt"],
  [/\bastro\b/, "Astro"],
  [/\bstorybook\b/, "Storybook"],
  [/\bremix\b/, "Remix"],
  [/\bvite\b/, "Vite"],
  [/\bwebpack(-dev-server|\b.*\bserve\b)/, "webpack dev server"],
  [/\breact-scripts\b/, "Create React App"],
  [/\b(expo|metro)\b/, "Metro"],
  [/\bhttp\.server\b/, "Python http.server"],
  [/\bmanage\.py\b.*\brunserver\b/, "Django"],
  [/\bflask\b/, "Flask"],
  [/\buvicorn\b/, "Uvicorn"],
  [/\bjekyll\b/, "Jekyll"],
  [/\bhugo\b/, "Hugo"],
  [/\b(rails|puma)\b/, "Rails"],
  [/\bphp\b.*\s-S\s/, "PHP server"],
  [/\bhttp-server\b/, "http-server"],
];

const INTERPRETERS = /^(node|bun|deno|python\d*(\.\d+)?|ruby|php|java)$/;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A name for the server from its command line, used until its page title is known. */
export function guessDevServerTitle(command: string): string {
  for (const [pattern, title] of KNOWN_SERVERS) {
    if (pattern.test(command)) return title;
  }
  const [program = "", ...rest] = command.split(" ").filter(Boolean);
  const script = INTERPRETERS.test(basename(program))
    ? rest.find((arg) => !arg.startsWith("-"))
    : undefined;
  return basename(script ?? program) || "Web server";
}

const displayHost = (url: string) => url.replace(/^https?:\/\//, "");

/**
 * One entry per process and port. A server that listens on 127.0.0.1 and ::1 separately (vite on
 * "localhost") reports two sockets; the IPv4 link wins because every browser reaches it.
 */
export function presentDevServers(
  listeners: ReadonlyArray<DevServerListener>,
): ReadonlyArray<DevServer> {
  const byKey = new Map<string, DevServerListener>();
  for (const listener of listeners) {
    const key = `${listener.port}:${listener.pid}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.url.includes("127.0.0.1") && listener.url.includes("127.0.0.1"))) {
      byKey.set(key, listener);
    }
  }
  return [...byKey.entries()]
    .map(([key, listener]) => ({
      key,
      port: listener.port,
      url: listener.url,
      address: displayHost(listener.url),
      title: guessDevServerTitle(listener.command),
      command: listener.command,
    }))
    .sort((left, right) => left.port - right.port);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** The page's <title>, or null when it has none. */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = match?.[1]
    ?.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 80) : null;
}

const pageTitles = new Map<string, string | null>();

function withPageTitles(list: ReadonlyArray<DevServer>): ReadonlyArray<DevServer> {
  return list.map((server) => {
    const title = pageTitles.get(server.key);
    return title ? { ...server, title } : server;
  });
}

let servers = presentDevServers(localServer?.listDevServers() ?? []);
const listeners = new Set<() => void>();

function publish(next: ReadonlyArray<DevServer>): void {
  servers = withPageTitles(next);
  for (const listener of listeners) listener();
}

localServer?.addListener("onDevServers", (event) => publish(presentDevServers(event.servers)));

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Web servers listening in the phone's Linux environment, pushed by the app when they change. */
export function useDevServers(): ReadonlyArray<DevServer> {
  return useSyncExternalStore(subscribe, () => servers);
}

const PAGE_TITLE_TIMEOUT_MS = 2_000;

/** Loads each server's page once for its <title>; servers that log requests show one GET. */
export function loadDevServerPageTitles(list: ReadonlyArray<DevServer>): void {
  for (const server of list) {
    if (pageTitles.has(server.key)) continue;
    pageTitles.set(server.key, null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TITLE_TIMEOUT_MS);
    void fetch(server.url, { signal: controller.signal })
      .then((response) =>
        response.headers.get("content-type")?.includes("text/html") ? response.text() : "",
      )
      .then((html) => {
        const title = htmlTitle(html);
        if (title === null) return;
        pageTitles.set(server.key, title);
        publish(servers);
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
}
