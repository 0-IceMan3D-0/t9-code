import { describe, expect, it, vi } from "vite-plus/test";

import type { DevServerListener } from "./localServerModule";

vi.mock("./localServerModule", () => ({ localServer: null }));

const { guessDevServerTitle, htmlTitle, presentDevServers } = await import("./devServers");

const listener = (overrides: Partial<DevServerListener>): DevServerListener => ({
  port: 8123,
  address: "0.0.0.0",
  url: `http://127.0.0.1:${overrides.port ?? 8123}`,
  pid: 100,
  command: "python3 -m http.server 8123",
  since: 1000,
  ...overrides,
});

describe("guessDevServerTitle", () => {
  it.each([
    ["node /root/app/node_modules/.bin/vite --host 127.0.0.1", "Vite"],
    ["node /root/app/node_modules/.bin/next dev", "Next.js"],
    ["next-server (v15.1.0)", "Next.js"],
    ["node /root/app/node_modules/.bin/nuxt dev", "Nuxt"],
    ["node /root/app/node_modules/.bin/astro dev", "Astro"],
    ["python3 -m http.server 8123", "Python http.server"],
    ["python3 manage.py runserver", "Django"],
    ["php -S 127.0.0.1:8000 -t public", "PHP server"],
    ["node server.js", "server.js"],
    ["/usr/local/bin/bun --watch /root/app/index.ts", "index.ts"],
    ["/root/go/bin/myserver -port 9000", "myserver"],
    ["", "Web server"],
  ])("%s -> %s", (command, title) => {
    expect(guessDevServerTitle(command)).toBe(title);
  });
});

describe("presentDevServers", () => {
  it("merges one process's IPv4 and IPv6 sockets on a port, preferring the IPv4 link", () => {
    const servers = presentDevServers([
      listener({ port: 5173, address: "::1", url: "http://[::1]:5173", command: "node vite" }),
      listener({
        port: 5173,
        address: "127.0.0.1",
        url: "http://127.0.0.1:5173",
        command: "node vite",
      }),
    ]);
    expect(servers).toEqual([
      {
        key: "5173:100",
        port: 5173,
        url: "http://127.0.0.1:5173",
        address: "127.0.0.1:5173",
        title: "Vite",
        command: "node vite",
      },
    ]);
  });

  it("keeps IPv6-only servers and different processes apart, sorted by port", () => {
    const servers = presentDevServers([
      listener({ port: 9000, pid: 7 }),
      listener({ port: 3000, address: "::1", url: "http://[::1]:3000", pid: 8 }),
      listener({ port: 9000, pid: 9 }),
    ]);
    expect(servers.map((server) => [server.key, server.address])).toEqual([
      ["3000:8", "[::1]:3000"],
      ["9000:7", "127.0.0.1:9000"],
      ["9000:9", "127.0.0.1:9000"],
    ]);
  });
});

describe("htmlTitle", () => {
  it("reads and cleans the title", () => {
    expect(htmlTitle("<html><head><TITLE lang=en>\n  Directory listing for /\n</TITLE>")).toBe(
      "Directory listing for /",
    );
    expect(htmlTitle("<title>Tom &amp; Jerry&#39;s &lt;app&gt;</title>")).toBe(
      "Tom & Jerry's <app>",
    );
  });

  it("returns null without a usable title", () => {
    expect(htmlTitle("<html><body>hi</body></html>")).toBeNull();
    expect(htmlTitle("<title>   </title>")).toBeNull();
  });
});
