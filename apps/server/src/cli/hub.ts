import * as Layer from "effect/Layer";
import * as OneChat from "../oneChat/OneChat.ts";
import * as HubAuth from "../hub/HubAuth.ts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpBody } from "effect/http";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { Command, Flag } from "effect/cli";
import { ExecutionEnvironmentDescriptor, PortSchema } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as HubHost from "../hub/HubHost.ts";
import { runServer } from "../server.ts";
import * as HubServer from "../hub/HubServer.ts";
import { connectEnvironment } from "../hub/EnvironmentTunnel.ts";
import { hubHostingFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import { pairCommand } from "./hubPair.ts";

export const hubFlags = {
  host: Flag.String("host").pipe(Flag.withDefault("127.0.0.1")),
  port: Flag.Int("port").pipe(Flag.withSchema(PortSchema), Flag.withDefault(4780)),
};

export const runHubCommand = Effect.fn("HubCli.run")(
  function* (options: {
    readonly host: string;
    readonly port: number;
    readonly config: ServerConfig.ServerConfig["Service"];
  }) {
    const hub = yield* HubServer.HubServer;
    const oneChat = yield* OneChat.OneChat;
    const { port } = yield* hub.listen({
      host: options.host,
      port: options.port,
      serveWeb: false,
      oneChat,
      ...(options.config.publicUrl ? { publicOrigin: options.config.publicUrl.origin } : {}),
    });
    const auth = yield* HubAuth.HubAuth;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${options.config.stateDir}/hub`, { recursive: true });
    const origin = options.config.publicUrl?.origin ?? `http://${options.host}:${port}`;
    yield* fs.writeFileString(
      `${options.config.stateDir}/hub/listener.json`,
      yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ origin: Schema.String, port: Schema.Number })),
      )({ origin, port }),
    );
    yield* Console.log(`Hub pairing token: ${yield* auth.startup()}`);
    yield* Console.log(`Hub: ${origin}/`);
    return yield* Effect.never;
  },
  (effect, options) =>
    effect.pipe(
      Effect.provide(
        HubServer.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(OneChat.layer(options.config), HubAuth.layer(options.config)),
          ),
        ),
      ),
    ),
);

export const hubCommand = Command.make("hub", {
  ...sharedServerCommandFlags,
  ...hubHostingFlags,
  ...hubFlags,
}).pipe(
  Command.withDescription("Run only the hub transport, without a client or local environment."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveServerConfig(
        { ...flags, host: Option.some(flags.host), port: Option.some(flags.port) },
        yield* GlobalFlag.LogLevel,
        { startupPresentation: "headless", forceAutoBootstrapProjectFromCwd: false },
      );
      return yield* runHubCommand({ host: flags.host, port: flags.port, config });
    }),
  ),
  Command.withSubcommands([pairCommand]),
);

export const environmentCommand = Command.make("environment", {
  ...sharedServerCommandFlags,
  hub: Flag.String("hub").pipe(Flag.withSchema(Schema.URLFromString)),
  invitation: Flag.String("invitation").pipe(Flag.optional),
}).pipe(
  Command.withAlias("daemon"),
  Command.withDescription(
    "Run an environment on loopback and connect it outward to a hub using a persistent enrollment credential.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (
        !["http:", "https:"].includes(flags.hub.protocol) ||
        flags.hub.username ||
        flags.hub.password
      ) {
        return yield* new HubServer.HubTransportError({
          cause: "Use an HTTP or HTTPS hub URL without credentials.",
        });
      }
      const config = yield* resolveServerConfig(flags, yield* GlobalFlag.LogLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      const ingressSecret = Buffer.from(yield* (yield* Crypto.Crypto).randomBytes(32)).toString(
        "base64url",
      );
      const fs = yield* FileSystem.FileSystem;
      const credentialsPath = `${config.stateDir}/hub-daemon-credentials.json`;
      const credentialsSchema = Schema.Record(Schema.String, Schema.String);
      const credentials = (yield* fs.exists(credentialsPath))
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(credentialsSchema))(
            yield* fs.readFileString(credentialsPath),
          )
        : {};
      // The environment is reachable only through its outbound tunnel; it never binds a public interface.
      const environmentConfig = {
        ...config,
        host: "127.0.0.1",
        noBrowser: true,
        noAuth: false,
        hubIngressSecret: ingressSecret,
        staticDir: undefined,
        devUrl: undefined,
        tailscaleServeEnabled: false,
      };
      return yield* Effect.raceFirst(
        runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, environmentConfig)),
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const descriptor = yield* client
            .get(`http://127.0.0.1:${config.port}/.well-known/t3/environment`)
            .pipe(
              Effect.timeout("3 seconds"),
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
            );
          let credential = credentials[flags.hub.origin];
          if (!credential) {
            if (Option.isNone(flags.invitation))
              throw new Error(
                "Create an environment invitation in Settings > Hub and pass --invitation <code>.",
              );
            const enrolled = yield* client
              .post(`${flags.hub.origin}/hub/auth/enroll`, {
                body: HttpBody.jsonUnsafe({
                  credential: flags.invitation.value,
                  environmentId: descriptor.environmentId,
                  label: descriptor.label,
                }),
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(
                  HttpClientResponse.schemaBodyJson(Schema.Struct({ credential: Schema.String })),
                ),
              );
            credential = enrolled.credential;
            yield* fs.writeFileString(
              `${credentialsPath}.tmp`,
              yield* Schema.encodeEffect(Schema.fromJsonString(credentialsSchema))({
                ...credentials,
                [flags.hub.origin]: credential,
              }),
            );
            yield* fs.chmod(`${credentialsPath}.tmp`, 0o600);
            yield* fs.rename(`${credentialsPath}.tmp`, credentialsPath);
          }
          yield* Console.log(`Environment ${descriptor.label} connecting to ${flags.hub.origin}`);
          return yield* connectEnvironment({
            hubUrl: flags.hub.toString(),
            localPort: config.port,
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            credential,
            ingressSecret,
          }).pipe(
            Effect.scoped,
            Effect.tapError(() => Effect.logWarning("Hub disconnected; reconnecting")),
            Effect.retry(Schedule.spaced("2 seconds")),
          );
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

export const clientCommand = Command.make("client", {
  ...sharedServerCommandFlags,
  ...hubHostingFlags,
  hub: Flag.String("hub").pipe(Flag.withSchema(Schema.URLFromString)),
}).pipe(
  Command.withDescription("Serve only the client, connected through its own origin to a hub."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveServerConfig(flags, yield* GlobalFlag.LogLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      return yield* Effect.flatMap(HubHost.HubHost, (host) =>
        host.run(config, { mode: "client", hubUrl: flags.hub.toString() }),
      ).pipe(Effect.provide(HubHost.layer));
    }),
  ),
);
