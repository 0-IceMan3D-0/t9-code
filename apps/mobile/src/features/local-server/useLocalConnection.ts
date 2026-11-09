import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";

/** The saved connection to the built-in server on this phone, if the app has paired with it. */
export function useLocalConnection(port: number | undefined) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return Object.values(savedConnectionsById).find(
    (connection) => connection.httpBaseUrl.replace(/\/$/, "") === `http://127.0.0.1:${port}`,
  );
}
