import * as HubAuth from "./HubAuth.ts";
import * as Crypto from "effect/Crypto";
import { HubSwitchInput } from "@t3tools/contracts";
import {
  ExecutionEnvironmentDescriptor,
  HubConnection,
  HubEnvironmentCatalog,
} from "@t3tools/contracts";
import { ensureTailscaleServe, disableTailscaleServe } from "@t3tools/tailscale";
import { ChildProcessSpawner } from "effect/process";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpBody } from "effect/http";
import * as ServerConfig from "../config.ts";
import { runServer } from "../server.ts";
import * as HubServer from "./HubServer.ts";
import { connectEnvironment } from "./EnvironmentTunnel.ts";

const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(HubConnection));
const encodeConnection = Schema.encodeEffect(Schema.fromJsonString(HubConnection));

type HostMode =
  | { readonly mode: "serve"; readonly environment: boolean }
  | { readonly mode: "client"; readonly hubUrl: string };

export class HubHost extends Context.Service<
  HubHost,
  {
    readonly run: (
      config: ServerConfig.ServerConfig["Service"],
      options?: HostMode,
    ) => Effect.Effect<never, HubServer.HubTransportError, Scope.Scope>;
  }
>()("t3/hub/HubHost") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hub = yield* HubServer.HubServer;
  const client = yield* HttpClient.HttpClient;

  const run = Effect.fn("HubHost.run")(
    function* (
      config: ServerConfig.ServerConfig["Service"],
      options: HostMode = { mode: "serve", environment: true },
    ) {
      const auth = yield* HubAuth.HubAuth;
      const ingressSecret = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
      const localPort =
        options.mode === "serve" && options.environment
          ? yield* net.reserveLoopbackPort()
          : undefined;
      const credentialsPath = path.join(config.stateDir, "hub-daemon-credentials.json");
      const credentialsSchema = Schema.Record(Schema.String, Schema.String);
      let credentials: Record<string, string> = (yield* fs.exists(credentialsPath))
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(credentialsSchema))(
            yield* fs.readFileString(credentialsPath),
          )
        : {};
      const connectionPath = path.join(config.stateDir, "hub-connection.json");
      let connection: HubConnection = { hubUrl: null };
      if (options.mode === "client") connection = { hubUrl: options.hubUrl };
      else if (yield* fs.exists(connectionPath)) {
        connection = yield* fs
          .readFileString(connectionPath)
          .pipe(Effect.flatMap(decodeConnection));
      }
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<Scope.Scope | HubAuth.HubAuth>();
      const runPromise = Effect.runPromiseWith(context);
      const lock = yield* Semaphore.make(1);
      let tunnel: Fiber.Fiber<void, HubServer.HubTransportError> | undefined;
      let descriptor: ExecutionEnvironmentDescriptor | undefined;
      const listener = yield* hub.listen({
        host: config.host ?? "127.0.0.1",
        port: config.port,
        ...(config.publicUrl ? { publicOrigin: config.publicUrl.origin } : {}),
        ...(localPort === undefined ? {} : { localPort }),
        ...(config.devUrl ? { devUrl: config.devUrl.toString() } : {}),
        ...(config.staticDir ? { staticDir: config.staticDir } : {}),
        connection: {
          read: () => ({
            ...connection,
            localHubAvailable: options.mode === "serve",
            localEnvironmentAvailable: localPort !== undefined,
            localDaemonAvailable: localPort !== undefined,
          }),
          switch: (next): Promise<string | undefined> => runPromise(switchHub(next)),
        },
      });
      if (config.tailscaleServeEnabled) {
        yield* ensureTailscaleServe({
          localPort: listener.port,
          servePort: config.tailscaleServePort,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* Effect.addFinalizer(() =>
          disableTailscaleServe({ servePort: config.tailscaleServePort }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.ignoreCause({ log: true }),
          ),
        );
      }
      const localHub = `http://127.0.0.1:${listener.port}`;

      const normalize = (input: HubConnection) =>
        Effect.try({
          try: () => {
            if (input.hubUrl === null) {
              if (options.mode === "client")
                throw new Error("Client-only mode requires a remote hub.");
              return input;
            }
            const url = new URL(input.hubUrl);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash ||
              (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
                Number(url.port) === listener.port)
            ) {
              throw new Error("Use an HTTP or HTTPS hub origin, or select the local hub.");
            }
            return { hubUrl: url.origin };
          },
          catch: (cause) => new HubServer.HubTransportError({ cause }),
        });
      const attach = Effect.fn("HubHost.attach")(function* (
        next: HubConnection,
        waitForRegistration = true,
      ) {
        if (tunnel) yield* Fiber.interrupt(tunnel);
        listener.setRemoteHub(next.hubUrl);
        if (localPort === undefined || descriptor === undefined) return;
        const registered = yield* Deferred.make<void>();
        tunnel = yield* connectEnvironment({
          hubUrl: next.hubUrl ?? localHub,
          credential: credentials[next.hubUrl ?? "local"],
          ingressSecret,
          localPort,
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          onRegistered: () => Effect.runSync(Deferred.succeed(registered, undefined)),
        }).pipe(Effect.scoped, Effect.retry(Schedule.spaced("2 seconds")), Effect.forkIn(scope));
        if (waitForRegistration)
          yield* Deferred.await(registered).pipe(Effect.timeout("15 seconds"));
      });
      const switchHub = Effect.fn("HubHost.switch")(function* (input: typeof HubSwitchInput.Type) {
        const next = yield* normalize(input);
        if (next.hubUrl === connection.hubUrl) return;
        let browserCookie: string | undefined;
        if (next.hubUrl) {
          if (!input.pairingCode)
            throw new Error("A pairing code from the destination hub is required.");
          const paired = yield* client
            .post(`${next.hubUrl}/hub/auth/pair`, {
              body: HttpBody.jsonUnsafe({ credential: input.pairingCode }),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(
                  Schema.Struct({ token: Schema.String, cookieName: Schema.String }),
                ),
              ),
              Effect.timeout("5 seconds"),
            );
          yield* client
            .get(`${next.hubUrl}/hub/environments`, {
              headers: { authorization: `Bearer ${paired.token}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(HubEnvironmentCatalog)),
              Effect.timeout("5 seconds"),
            );
          browserCookie = `${paired.cookieName}=${paired.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
          if (descriptor && localPort !== undefined && !credentials[next.hubUrl]) {
            const invitation = input.environmentInvitation ?? input.daemonInvitation;
            if (!invitation)
              throw new Error("An environment invitation from the destination hub is required.");
            const enrolled = yield* client
              .post(`${next.hubUrl}/hub/auth/enroll`, {
                body: HttpBody.jsonUnsafe({
                  credential: invitation,
                  environmentId: descriptor.environmentId,
                  label: descriptor.label,
                }),
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(
                  HttpClientResponse.schemaBodyJson(Schema.Struct({ credential: Schema.String })),
                ),
                Effect.timeout("5 seconds"),
              );
            credentials = { ...credentials, [next.hubUrl]: enrolled.credential };
          }
        }
        const previous = connection;
        yield* Effect.gen(function* () {
          yield* attach(next);
          yield* fs.makeDirectory(config.stateDir, { recursive: true });
          yield* fs.writeFileString(`${connectionPath}.tmp`, yield* encodeConnection(next));
          yield* fs.rename(`${connectionPath}.tmp`, connectionPath);
          yield* fs.writeFileString(
            `${credentialsPath}.tmp`,
            yield* Schema.encodeEffect(Schema.fromJsonString(credentialsSchema))(credentials),
          );
          yield* fs.chmod(`${credentialsPath}.tmp`, 0o600);
          yield* fs.rename(`${credentialsPath}.tmp`, credentialsPath);
          connection = next;
        }).pipe(Effect.tapError(() => attach(previous)));
        return browserCookie;
      }, lock.withPermit);

      connection = yield* normalize(connection);
      listener.setRemoteHub(connection.hubUrl);
      const startupCredential = yield* auth.startup();
      const clientOrigin =
        config.publicUrl?.origin ??
        config.devUrl?.origin ??
        `http://${config.host ?? "127.0.0.1"}:${listener.port}`;
      const pairingUrl = `${clientOrigin}/pair#token=${encodeURIComponent(startupCredential)}&local=1`;
      yield* fs.makeDirectory(path.join(config.stateDir, "hub"), { recursive: true });
      yield* fs.writeFileString(
        path.join(config.stateDir, "hub", "listener.json"),
        yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ origin: Schema.String, port: Schema.Number })),
        )({ origin: clientOrigin, port: listener.port }),
      );
      yield* Effect.logInfo(`pairingUrl: ${pairingUrl}`);
      if (localPort === undefined) {
        yield* Effect.logInfo(
          `T3 Code: http://${config.host ?? "127.0.0.1"}:${listener.port} (no environment)`,
        );
        return yield* Effect.never;
      }
      const environmentConfig = {
        ...config,
        port: localPort,
        host: "127.0.0.1",
        noBrowser: true,
        noAuth: false,
        hubIngressSecret: ingressSecret,
        staticDir: undefined,
        devUrl: undefined,
        tailscaleServeEnabled: false,
      };
      const environment = yield* runServer.pipe(
        Effect.provideService(ServerConfig.ServerConfig, environmentConfig),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.forkScoped,
      );
      descriptor = yield* client
        .get(`http://127.0.0.1:${localPort}/.well-known/t3/environment`)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
          Effect.timeout("3 seconds"),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
        );
      credentials.local = (yield* auth.enrollLocal(
        descriptor.environmentId,
        descriptor.label,
      )).token;
      if (connection.hubUrl && !credentials[connection.hubUrl])
        throw new Error("Enroll this environment through Hub settings before using a remote hub.");
      yield* attach(connection, connection.hubUrl === null);
      yield* Effect.logInfo(`T3 Code: http://${config.host ?? "127.0.0.1"}:${listener.port}`);
      return yield* Fiber.join(environment);
    },
    (effect, config) =>
      effect.pipe(
        Effect.provide(
          HubAuth.layer(config).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, fs),
                Layer.succeed(Path.Path, path),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        ),
      ),
    Effect.mapError((cause) => new HubServer.HubTransportError({ cause })),
  );
  return HubHost.of({ run });
});

export const layer = Layer.effect(HubHost, make).pipe(
  Layer.provide(HubServer.layer),
  Layer.provide(FetchHttpClient.layer),
);
