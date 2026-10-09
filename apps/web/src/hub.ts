import { HubConnection, HubEnvironmentCatalog, HubSessionState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeConnection = Schema.decodeUnknownSync(HubConnection);
const decodeSession = Schema.decodeUnknownSync(HubSessionState);
const decodeCatalog = Schema.decodeUnknownSync(HubEnvironmentCatalog);
let catalog: HubEnvironmentCatalog | null = null;
let session: HubSessionState | null = null;
let sessionCheckedAt = 0;
let sessionRequest: Promise<HubSessionState> | null = null;
let sessionGeneration = 0;
export const HUB_SESSION_CHANGED_EVENT = "pulse:hub-session-changed";
const SESSION_RECHECK_MS = 30_000;

function clearHubSession() {
  session = null;
  sessionRequest = null;
  sessionGeneration++;
}

/** An authenticated endpoint rejected the cookie; the route gate must check it again. */
export function invalidateHubSession() {
  if (!session) return;
  clearHubSession();
  window.dispatchEvent(new Event(HUB_SESSION_CHANGED_EVENT));
}

/** Navigation uses known auth state; stale state revalidates without delaying the page. */
export function loadHubSession() {
  if (!session) return fetchHubSession();
  if (Date.now() - sessionCheckedAt >= SESSION_RECHECK_MS) {
    void fetchHubSession().catch(() => undefined);
  }
  return Promise.resolve(session);
}

export function updateHubCatalog(next: HubEnvironmentCatalog) {
  catalog = next;
}

export function readHubCatalog() {
  return catalog;
}
export function readHubPrimaryEnvironment() {
  return (
    catalog?.environments.find((environment) => environment.connected) ?? catalog?.environments[0]
  );
}
export function hubEnvironmentBaseUrl(environmentId: string) {
  return `${window.location.origin}/hub/environments/${encodeURIComponent(environmentId)}/`;
}

/** Detect a hub before the existing primary-environment bootstrap runs. */
export async function loadHubBootstrap() {
  if (catalog) return catalog;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const token = hash.get("token");
  const desktopToken = window.desktopBridge
    ?.getLocalEnvironmentBootstraps()
    ?.find((b) => b.bootstrapToken)?.bootstrapToken;
  if (token || desktopToken) {
    try {
      if (token) {
        url.hash = "";
        window.history.replaceState(window.history.state, "", url);
      }
      await pairWithHub(token ?? desktopToken ?? "", hash.get("local") === "1" || !token);
    } catch {
      /* The pairing surface handles a rejected explicit credential. */
    }
  }
  try {
    const response = await fetch("/hub/environments", { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("Hub unavailable");
    catalog = decodeCatalog(await response.json());
    return catalog;
  } catch {
    // Connection settings belong to this installation and remain reachable when its hub is offline.
    try {
      const response = await fetch("/hub/connection", { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return null;
      decodeConnection(await response.json());
      catalog = { environments: [] };
      return catalog;
    } catch {
      return null;
    }
  }
}

/** Settings can request fresh permissions; concurrent checks share one request. */
export function fetchHubSession(): Promise<HubSessionState> {
  if (sessionRequest) return sessionRequest;
  const generation = sessionGeneration;
  const request = (async () => {
    const response = await fetch("/hub/auth/session", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Hub unavailable.");
    const next = decodeSession(await response.json());
    if (generation !== sessionGeneration) return next;
    const changed =
      session !== null &&
      (session.authenticated !== next.authenticated ||
        session.role !== next.role ||
        session.sessionId !== next.sessionId);
    session = next;
    sessionCheckedAt = Date.now();
    if (changed) window.dispatchEvent(new Event(HUB_SESSION_CHANGED_EVENT));
    return next;
  })();
  sessionRequest = request;
  void request
    .finally(() => {
      if (sessionRequest === request) sessionRequest = null;
    })
    .catch(() => undefined);
  return request;
}
export async function pairWithHub(credential: string, local = false) {
  const response = await fetch(local ? "/hub/local-auth/pair" : "/hub/auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw new Error("Invalid or expired pairing code.");
  catalog = null;
  clearHubSession();
}
