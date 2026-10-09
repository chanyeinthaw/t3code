import {
  ensureTailscaleServe,
  readTailscaleStatus,
  buildTailscaleHttpsBaseUrl,
} from "@t3tools/tailscale";
import { PortSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Console from "effect/Console";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { AuthGrantScope, HubAccessRole } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { hubAuthConfig } from "../hub/config.ts";
import { authLocationFlags, resolveCliAuthConfig, DurationFromString } from "./config.ts";
import { hubRoleScopes } from "../hub/HubAuth.ts";
import { buildPairingUrl, renderTerminalQrCode } from "../startupAccess.ts";

export const pairCommand = Command.make("pair", {
  ...authLocationFlags,
  role: Flag.Literals("role", HubAccessRole.literals).pipe(
    Flag.withDefault("standard"),
    Flag.withDescription("Client access role: standard, read-only, or admin."),
  ),
  scopes: Flag.Literals("scope", AuthGrantScope.literals).pipe(
    Flag.atLeast(0),
    Flag.withDescription("Explicit scope to grant; repeat to replace the selected role's scopes."),
  ),
  ttl: Flag.String("ttl").pipe(Flag.withSchema(DurationFromString), Flag.optional),
  label: Flag.String("label").pipe(Flag.optional),
  tailscale: Flag.Boolean("tailscale").pipe(Flag.withDefault(false)),
  tailscaleServePort: Flag.Int("tailscale-serve-port").pipe(
    Flag.withSchema(PortSchema),
    Flag.withDefault(443),
  ),
}).pipe(
  Command.withDescription("Create a one-time client pairing link for this installation’s hub."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = hubAuthConfig(yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel));
      const fs = yield* FileSystem.FileSystem;
      const listener = yield* fs
        .readFileString(`${config.stateDir}/listener.json`)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ origin: Schema.String, port: Schema.Number })),
            ),
          ),
        );
      const issued = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.flatMap((auth) =>
          auth.createPairingLink({
            scopes: flags.scopes.length > 0 ? flags.scopes : hubRoleScopes(flags.role),
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          }),
        ),
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
      let origin = listener.origin;
      if (flags.tailscale) {
        const status = yield* readTailscaleStatus;
        if (!status.magicDnsName) throw new Error("Tailscale DNS is unavailable.");
        yield* ensureTailscaleServe({
          localPort: listener.port,
          servePort: flags.tailscaleServePort,
        });
        origin = buildTailscaleHttpsBaseUrl({
          magicDnsName: status.magicDnsName,
          servePort: flags.tailscaleServePort,
        });
      }
      const url = buildPairingUrl(origin, issued.credential);
      yield* Console.log(`Pairing URL: ${url}\n${renderTerminalQrCode(url)}`);
    }),
  ),
);
