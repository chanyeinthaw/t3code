import { afterEach, expect, it, vi } from "vite-plus/test";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const authenticated = { authenticated: true, role: "standard", sessionId: "client" };

async function setup() {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(authenticated));
  vi.stubGlobal("fetch", fetch);
  return { hub: await import("./hub"), fetch, events };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shares the initial auth request and reuses it across route changes", async () => {
  const { hub, fetch } = await setup();
  const initial = hub.loadHubSession();
  const concurrent = hub.loadHubSession();
  expect(await initial).toEqual(authenticated);
  expect(await concurrent).toEqual(authenticated);
  expect(await hub.loadHubSession()).toEqual(authenticated);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("revalidates stale auth without blocking navigation and reports revocation", async () => {
  const { hub, fetch, events } = await setup();
  await hub.loadHubSession();
  vi.setSystemTime(30_001);
  const revoked = deferredResponse();
  fetch.mockReturnValueOnce(revoked.promise);
  const changed = vi.fn();
  events.addEventListener(hub.HUB_SESSION_CHANGED_EVENT, changed);
  expect(await hub.loadHubSession()).toEqual(authenticated);
  expect(changed).not.toHaveBeenCalled();
  revoked.resolve(Response.json({ authenticated: false }));
  await hub.fetchHubSession();
  expect(changed).toHaveBeenCalledOnce();
  expect(await hub.loadHubSession()).toEqual({ authenticated: false });
});

it("checks fresh permissions explicitly and invalidates rejected credentials", async () => {
  const { hub, fetch } = await setup();
  await hub.loadHubSession();
  fetch.mockResolvedValueOnce(Response.json({ ...authenticated, role: "read-only" }));
  expect((await hub.fetchHubSession()).role).toBe("read-only");
  hub.invalidateHubSession();
  fetch.mockResolvedValueOnce(Response.json({ authenticated: false }));
  expect(await hub.loadHubSession()).toEqual({ authenticated: false });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not let a request from before pairing overwrite the new session", async () => {
  const { hub, fetch } = await setup();
  const old = deferredResponse();
  fetch.mockReturnValueOnce(old.promise);
  const previous = hub.loadHubSession();
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await hub.pairWithHub("test-code");
  const next = { ...authenticated, sessionId: "new-client" };
  fetch.mockResolvedValueOnce(Response.json(next));
  expect(await hub.loadHubSession()).toEqual(next);
  old.resolve(Response.json(authenticated));
  await previous;
  expect(await hub.loadHubSession()).toEqual(next);
});

it("keeps cached navigation usable during an outage and retries failed checks", async () => {
  const { hub, fetch } = await setup();
  await hub.loadHubSession();
  vi.setSystemTime(30_001);
  fetch.mockRejectedValueOnce(new Error("Offline"));
  expect(await hub.loadHubSession()).toEqual(authenticated);
  await expect(hub.fetchHubSession()).rejects.toThrow("Offline");
  fetch.mockResolvedValueOnce(Response.json(authenticated));
  expect(await hub.fetchHubSession()).toEqual(authenticated);
});
