import { describe, expect, it } from "vite-plus/test";

import { shellTabTitle, tabAfterClose } from "./linuxShellTabs";

const info = (overrides: { command?: string | null; title?: string | null; busy?: boolean }) => ({
  id: "1",
  command: null,
  title: null,
  busy: false,
  ...overrides,
});

describe("shellTabTitle", () => {
  it.each([
    [info({ title: "root@localhost: ~" }), "~"],
    [info({ title: "root@localhost: /" }), "/"],
    [info({ title: "root@localhost: ~/projects/app" }), "app"],
    [info({ title: "vim notes.md" }), "vim notes.md"],
    [info({}), "bash"],
    [info({ busy: true, command: "/usr/bin/sleep 300", title: "root@localhost: ~" }), "sleep 300"],
    [info({ busy: true, command: "python3 -m http.server 8000" }), "python3 -m http.s…"],
    [info({ busy: true, command: null, title: "root@localhost: /tmp" }), "tmp"],
  ])("titles %j as %s", (value, title) => {
    expect(shellTabTitle(value)).toBe(title);
  });
});

describe("tabAfterClose", () => {
  it("keeps another active tab", () => {
    expect(tabAfterClose(["1", "2", "3"], "2", "3")).toBe("3");
  });

  it("moves to the previous tab, or the next one for the first", () => {
    expect(tabAfterClose(["1", "2", "3"], "2", "2")).toBe("1");
    expect(tabAfterClose(["1", "2", "3"], "1", "1")).toBe("2");
    expect(tabAfterClose(["1"], "1", "1")).toBeNull();
  });
});
