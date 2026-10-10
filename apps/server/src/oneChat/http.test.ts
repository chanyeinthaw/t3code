// @effect-diagnostics globalFetchInEffect:off globalFetch:off -- Exercise authenticated hub requests through its real HTTP listener.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "../hub/HubAuth.ts";
import * as HubServer from "../hub/HubServer.ts";
import * as OneChat from "./OneChat.ts";

const services = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return Layer.mergeAll(HubAuth.layer(config), OneChat.layer(config));
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pulse-one-chat-http-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("only hub admins can configure One Chat and writes require the correct origin", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const hub = yield* HubServer.HubServer;
    const chat = yield* OneChat.OneChat;
    const owner = yield* auth.exchange(yield* auth.startup());
    const reader = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "read-only", ttlMinutes: 10 })).credential,
    );
    const standard = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    const { port } = yield* hub.listen({
      host: "127.0.0.1",
      port: 0,
      oneChat: chat,
      publicOrigin: "https://pulse.example.test",
    });
    const settings = {
      environmentId: EnvironmentId.make("worker"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
    };
    const request = (
      token?: string,
      method = "GET",
      origin = "https://pulse.example.test",
      body = JSON.stringify(settings),
    ) =>
      Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/hub/one-chat`, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            origin,
            "content-type": "application/json",
          },
          ...(method === "PUT" ? { body } : {}),
        }),
      );
    expect((yield* request()).status).toBe(401);
    expect((yield* request(reader.token)).status).toBe(200);
    expect((yield* request(reader.token, "PUT")).status).toBe(403);
    expect((yield* request(standard.token, "PUT")).status).toBe(403);
    expect((yield* request(owner.token, "PUT", "https://wrong.example")).status).toBe(403);
    expect((yield* request(owner.token, "PUT", undefined, "{}")).status).toBe(400);
    expect((yield* request(owner.token, "PUT")).status).toBe(200);
    expect(yield* chat.read()).toMatchObject(settings);
    expect((yield* request(standard.token, "DELETE")).status).toBe(403);
    expect((yield* request(owner.token, "DELETE")).status).toBe(200);
    expect(yield* chat.read()).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(HubServer.layer.pipe(Layer.provideMerge(services)))),
);

it.effect("agent management enforces admin permissions, origins, and safe IDs", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const hub = yield* HubServer.HubServer;
    const agents = yield* OneChat.OneChat;
    const owner = yield* auth.exchange(yield* auth.startup());
    const standard = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    const { port } = yield* hub.listen({
      host: "127.0.0.1",
      port: 0,
      oneChat: agents,
      publicOrigin: "https://pulse.example.test",
    });
    const settings = {
      id: "research",
      name: "Research",
      environmentId: "worker",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      additionalInstructions: "Cite sources",
    };
    const request = (
      token: string,
      method = "GET",
      origin = "https://pulse.example.test",
      id = "research",
      body = settings,
    ) =>
      Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/hub/agents?id=${encodeURIComponent(id)}`, {
          method,
          headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" },
          ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
        }),
      );
    expect((yield* request(standard.token)).status).toBe(200);
    for (const method of ["PUT", "POST", "DELETE"]) {
      expect((yield* request(standard.token, method)).status).toBe(403);
      expect((yield* request(owner.token, method, "https://wrong.example")).status).toBe(403);
    }
    expect(
      (yield* request(owner.token, "PUT", undefined, undefined, { ...settings, id: "../outside" }))
        .status,
    ).toBe(400);
    expect((yield* request(owner.token, "PUT")).status).toBe(200);
    expect(yield* agents.listAgents()).toHaveLength(2);
    expect((yield* request(owner.token, "POST")).status).toBe(200);
    expect(
      (yield* agents.listAgents()).find((agent) => agent.id === "research")?.configuration,
    ).toBeNull();
    expect((yield* request(owner.token, "DELETE", undefined, "pulse")).status).toBe(400);
    expect((yield* request(owner.token, "DELETE")).status).toBe(200);
    expect((yield* request(owner.token, "DELETE")).status).toBe(404);
    expect(yield* agents.listAgents()).toEqual([
      { id: "pulse", name: "Pulse", configuration: null },
    ]);
  }).pipe(Effect.scoped, Effect.provide(HubServer.layer.pipe(Layer.provideMerge(services)))),
);
