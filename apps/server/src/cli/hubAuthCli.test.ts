import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthGrantScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { cli } from "../binCli.ts";

const GrantedScopes = Schema.Struct({ scopes: Schema.Array(AuthGrantScope) });
const decodeIssued = Schema.decodeEffect(Schema.fromJsonString(GrantedScopes));
const decodeListed = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(GrantedScopes)));

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer))(
  "hub auth CLI",
  (it) => {
    it.effect.each([
      { group: "pairing", action: "create" },
      { group: "session", action: "issue" },
    ] as const)("persists selected scopes in a fresh hub home for $group", ({ group, action }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-hub-auth-cli-" });
        const runCli = (args: ReadonlyArray<string>) =>
          Command.runWith(cli, { version: "0.0.0" })(args).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          );
        const latestOutput = Effect.gen(function* () {
          return (
            (yield* TestConsole.logLines).findLast(
              (line): line is string => typeof line === "string",
            ) ?? ""
          );
        });
        yield* runCli([
          "auth",
          group,
          action,
          "--base-dir",
          home,
          "--json",
          "--scope",
          "orchestration:read",
          "--scope",
          "access:read",
          "--scope",
          "orchestration:read",
        ]);
        const issued = yield* decodeIssued(yield* latestOutput);
        yield* runCli(["auth", group, "list", "--base-dir", home, "--json"]);
        const listed = yield* decodeListed(yield* latestOutput);
        assert.deepEqual(issued.scopes, ["orchestration:read", "access:read"]);
        assert.lengthOf(listed, 1);
        assert.deepEqual(listed[0]?.scopes, issued.scopes);
        assert.equal(yield* fs.exists(`${home}/userdata/hub/environment-id`), true);
        assert.equal(yield* fs.exists(`${home}/userdata/statev2.sqlite`), false);
      }).pipe(Effect.scoped),
    );
  },
);
