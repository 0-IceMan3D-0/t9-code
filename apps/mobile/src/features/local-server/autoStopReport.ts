import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { summarizeLocalThreadWork } from "./autoStopWork";
import { getLocalServerStatus, localServer, subscribeLocalServerStatus } from "./localServerModule";

const RETRY_MS = 5_000;

/**
 * Tells the native auto-stop which of the built-in server's threads still work or wait on the
 * user. Shell pushes keep arriving in the background, so this stays event-driven.
 */
export function installLocalServerAutoStopReport(): () => void {
  const server = localServer;
  if (server === null) return () => {};
  let environmentId: EnvironmentId | null = null;
  let lastReport = "";
  let stopShell = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;

  const report = (value: object) => {
    const json = JSON.stringify(value);
    if (json === lastReport) return;
    lastReport = json;
    server.reportThreadWork(json);
  };

  const watch = () => {
    stopShell();
    stopShell = () => {};
    if (environmentId === null) return report({ known: false });
    // Not saved in this app means no thread here can be running on it.
    if (!appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.has(environmentId)) {
      return report({ known: true, working: 0, needsYou: 0 });
    }
    stopShell = appAtomRegistry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
          return report({ known: false });
        }
        report({ known: true, ...summarizeLocalThreadWork(shell.snapshot.value.threads) });
      },
      { immediate: true },
    );
  };

  // A connection that failed while the server was down backs off on JS timers, which stop
  // once the app is in the background, so it would never see the threads without a nudge.
  const reconnectIfIdle = (id: EnvironmentId) => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (!catalog.entries.has(id)) return;
    if (appAtomRegistry.get(environmentShell.stateValueAtom(id)).status === "live") return;
    void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, id);
  };

  const resolveEnvironment = () => {
    clearTimeout(retry);
    const status = getLocalServerStatus();
    if (status?.state !== "running") return;
    fetch(`http://127.0.0.1:${status.port}/.well-known/t3/environment`)
      .then((response) => response.json() as Promise<{ readonly environmentId: EnvironmentId }>)
      .then((body) => {
        if (body.environmentId !== environmentId) {
          environmentId = body.environmentId;
          watch();
        }
        reconnectIfIdle(body.environmentId);
      })
      .catch(() => {
        retry = setTimeout(resolveEnvironment, RETRY_MS);
      });
  };

  const unsubscribeStatus = subscribeLocalServerStatus(resolveEnvironment);
  const unsubscribeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, watch);
  watch();
  resolveEnvironment();
  return () => {
    clearTimeout(retry);
    unsubscribeStatus();
    unsubscribeCatalog();
    stopShell();
  };
}
