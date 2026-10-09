import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "./HubAuth.ts";
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalFetch:off -- Exercise the real Node HTTP and WebSocket transport end to end.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import WebSocket, { WebSocketServer } from "ws";
import * as HubServer from "./HubServer.ts";
import { connectEnvironment } from "./EnvironmentTunnel.ts";

const nextMessage = (socket: WebSocket) =>
  new Promise<Buffer>((resolve) =>
    socket.once("message", (data) => {
      resolve(
        Buffer.from(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : Array.isArray(data)
              ? Buffer.concat(data)
              : data,
        ),
      );
    }),
  );

it.effect(
  "routes HTTP bodies and concurrent WebSockets through an outbound environment and disconnects cleanly",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* HubAuth.HubAuth;
        const owner = yield* auth.exchange(yield* auth.startup());
        const authorizedFetch = (url: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${owner.token}`);
          return globalThis.fetch(url, { ...init, headers });
        };
        const local = NodeHttp.createServer((request, response) => {
          if (request.url === "/hub") {
            response.end("web app");
            return;
          }
          if (request.url === "/.well-known/t3/environment") {
            response.end("registered");
            return;
          }
          const parts: Buffer[] = [];
          request.on("data", (part: Buffer) => parts.push(part));
          request.on("end", () => {
            response.setHeader("x-environment", "test");
            response.end(Buffer.concat(parts));
          });
        });
        const echo = new WebSocketServer({ server: local });
        echo.on("connection", (socket) =>
          socket.on("message", (data, binary) => socket.send(data, { binary })),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const socket of echo.clients) socket.terminate();
            echo.close();
            local.closeAllConnections();
            await new Promise<void>((resolve) => local.close(() => resolve()));
          }),
        );
        const address = local.address();
        if (!address || typeof address === "string") throw new Error("Missing local address");
        const hub = yield* HubServer.HubServer;
        const { port, setRemoteHub } = yield* hub.listen({
          host: "127.0.0.1",
          port: 0,
          publicOrigin: "https://pulse.example.test",
          devUrl: `http://127.0.0.1:${address.port}`,
        });
        const origin = `http://127.0.0.1:${port}`;
        expect(
          (yield* Effect.promise(() => globalThis.fetch(`${origin}/hub/environments`))).status,
        ).toBe(401);
        expect(
          (yield* Effect.promise(() =>
            globalThis.fetch(`${origin}/hub/auth/pairing`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${owner.token}`,
                origin: "https://other.example",
                "content-type": "application/json",
              },
              body: JSON.stringify({ role: "admin", ttlMinutes: 10 }),
            }),
          )).status,
        ).toBe(403);
        let registered!: () => void;
        const ready = new Promise<void>((resolve) => {
          registered = resolve;
        });
        const environment = yield* connectEnvironment({
          hubUrl: origin,
          localPort: address.port,
          environmentId: "worker",
          credential: (yield* auth.enrollLocal("worker", "Worker")).token,
          label: "Worker",
          onRegistered: registered,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* Effect.promise(() => ready);
        const list = yield* Effect.promise(async () =>
          (await authorizedFetch(`${origin}/hub/environments`)).text(),
        );
        expect(list).toContain("Worker");
        const other = NodeHttp.createServer((_request, response) => response.end("Other machine"));
        yield* Effect.promise(
          () => new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            other.closeAllConnections();
            await new Promise<void>((resolve) => other.close(() => resolve()));
          }),
        );
        const otherAddress = other.address();
        if (!otherAddress || typeof otherAddress === "string")
          throw new Error("Missing second address");
        let otherRegistered!: () => void;
        const otherReady = new Promise<void>((resolve) => {
          otherRegistered = resolve;
        });
        yield* connectEnvironment({
          hubUrl: origin,
          localPort: otherAddress.port,
          environmentId: "other",
          credential: (yield* auth.enrollLocal("other", "Other")).token,
          label: "Other",
          onRegistered: otherRegistered,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* Effect.promise(() => otherReady);
        const concurrent = yield* Effect.promise(() =>
          Promise.all([
            authorizedFetch(`${origin}/hub/environments/other/echo`),
            authorizedFetch(`${origin}/hub/environments/worker/echo`, {
              method: "POST",
              body: "First machine",
            }),
          ]).then((responses) => Promise.all(responses.map((response) => response.text()))),
        );
        expect(concurrent).toEqual(["Other machine", "First machine"]);
        const web = yield* Effect.promise(() => authorizedFetch(`${origin}/hub`));
        expect(yield* Effect.promise(() => web.text())).toBe("web app");
        const ambiguous = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/api/test`, {
            headers: { cookie: "t3-hub-environment=worker" },
          }),
        );
        expect(ambiguous.status).toBe(400);
        const headers = {
          origin: "https://pulse.example.test",
          cookie: "t3-hub-environment=worker",
          authorization: `Bearer ${owner.token}`,
        };
        const body = Buffer.alloc(160_000, 42);
        const response = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/hub/environments/worker/echo`, {
            method: "POST",
            headers,
            body,
          }),
        );
        expect(response.headers.get("x-environment")).toBe("test");
        expect(Buffer.from(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(body);
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/hub/environments/worker/ws?orchestrationProtocol=2`,
          "t3-test",
          {
            headers,
          },
        );
        yield* Effect.promise(() => new Promise<void>((resolve) => socket.once("open", resolve)));
        expect(socket.protocol).toBe("t3-test");
        const reply = nextMessage(socket);
        socket.send("rpc-frame");
        expect((yield* Effect.promise(() => reply)).toString()).toBe("rpc-frame");
        const binary = nextMessage(socket);
        socket.send(Buffer.from([0, 255, 1]));
        expect(yield* Effect.promise(() => binary)).toEqual(Buffer.from([0, 255, 1]));
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        yield* Fiber.interrupt(environment);
        yield* Effect.promise(() => closed);
        const unavailable = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/hub/environments/worker/api/test`, { headers }),
        );
        expect(unavailable.status).toBe(503);
        const stillAvailable = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/hub/environments/other/echo`),
        );
        expect(yield* Effect.promise(() => stillAvailable.text())).toBe("Other machine");
        const offline = yield* Effect.promise(async () =>
          (await authorizedFetch(`${origin}/hub/environments`)).text(),
        );
        expect(offline).toContain('"environmentId":"worker","label":"Worker","connected":false');

        const remote = yield* hub.listen({ host: "127.0.0.1", port: 0 });
        const remoteOrigin = `http://127.0.0.1:${remote.port}`;
        let remoteRegistered!: () => void;
        const remoteReady = new Promise<void>((resolve) => {
          remoteRegistered = resolve;
        });
        yield* connectEnvironment({
          hubUrl: remoteOrigin,
          localPort: address.port,
          environmentId: "remote-worker",
          credential: (yield* auth.enrollLocal("remote-worker", "Remote worker")).token,
          label: "Remote worker",
          onRegistered: remoteRegistered,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* Effect.promise(() => remoteReady);
        const observer = (yield* auth.enrollLocal("observer", "Observer")).token;
        const otherClosed = new Promise<void>((resolve) => {
          // The local registry's connected environment must be disconnected when hosting stops.
          const socket = new WebSocket(`ws://127.0.0.1:${port}/hub/daemon?environmentId=observer`, {
            headers: { authorization: `Bearer ${observer}` },
          });
          socket.on("open", () => {
            socket.send(
              JSON.stringify({ type: "register", environmentId: "observer", label: "Observer" }),
            );
          });
          socket.once("message", () => {
            setRemoteHub(remoteOrigin);
          });
          socket.once("close", () => resolve());
        });
        yield* Effect.promise(() => otherClosed);
        const remoteCatalog = yield* Effect.promise(async () =>
          (await authorizedFetch(`${origin}/hub/environments`)).json(),
        );
        expect(remoteCatalog).toEqual({
          environments: [
            { environmentId: "remote-worker", label: "Remote worker", connected: true },
          ],
        });
        const proxied = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/hub/environments/remote-worker/echo`, {
            method: "POST",
            body: "Through selected hub",
          }),
        );
        expect(yield* Effect.promise(() => proxied.text())).toBe("Through selected hub");
        const forwarded = new WebSocket(
          `ws://127.0.0.1:${port}/hub/environments/remote-worker/ws`,
          "t3-test",
          { headers: { authorization: `Bearer ${owner.token}` } },
        );
        const immediateReply = nextMessage(forwarded);
        forwarded.once("open", () => forwarded.send("first frame"));
        expect((yield* Effect.promise(() => immediateReply)).toString()).toBe("first frame");
        forwarded.terminate();
        const rejectedEnrollment = new WebSocket(`ws://127.0.0.1:${port}/hub/daemon`);
        const enrollmentStatus = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              rejectedEnrollment.on("unexpected-response", (_request, response) => {
                response.resume();
                rejectedEnrollment.terminate();
                resolve(response.statusCode ?? 0);
              });
              rejectedEnrollment.on("error", () => {});
            }),
        );
        expect(enrollmentStatus).toBe(409);
        setRemoteHub(null);
        const localCatalog = yield* Effect.promise(async () =>
          (await authorizedFetch(`${origin}/hub/environments`)).json(),
        );
        expect(localCatalog).toEqual({ environments: [] });
        let restored!: () => void;
        const restoredReady = new Promise<void>((resolve) => {
          restored = resolve;
        });
        yield* connectEnvironment({
          hubUrl: origin,
          localPort: address.port,
          environmentId: "worker",
          credential: (yield* auth.enrollLocal("worker", "Worker")).token,
          label: "Worker",
          onRegistered: restored,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* Effect.promise(() => restoredReady);
        const restoredResponse = yield* Effect.promise(() =>
          authorizedFetch(`${origin}/hub/environments/worker/echo`, {
            method: "POST",
            body: "Local again",
          }),
        );
        expect(yield* Effect.promise(() => restoredResponse.text())).toBe("Local again");
      }),
    ).pipe(
      Effect.provide(HubServer.layer),
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            return HubAuth.layer(yield* ServerConfig.ServerConfig);
          }),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-transport-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
