import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  AuthOrchestrationOperateScope,
  AuthFilesystemWriteScope,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "./HubAuth.ts";

const layer = Layer.unwrap(
  Effect.gen(function* () {
    return HubAuth.layer(yield* ServerConfig.ServerConfig);
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-auth-" })),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "client links are single-use and read-only sessions cannot mint links or environment invitations",
  () =>
    Effect.gen(function* () {
      const auth = yield* HubAuth.HubAuth;
      const owner = yield* auth.exchange(yield* auth.startup());
      const link = yield* auth.createPairing(owner.token, { role: "read-only", ttlMinutes: 10 });
      const reader = yield* auth.exchange(link.credential);
      expect(reader.scopes).not.toContain(AuthOrchestrationOperateScope);
      expect(reader.scopes).not.toContain(AuthFilesystemWriteScope);
      expect(Exit.isFailure(yield* auth.exchange(link.credential).pipe(Effect.exit))).toBe(true);
      expect(
        Exit.isFailure(
          yield* auth
            .createPairing(reader.token, { role: "admin", ttlMinutes: 10 })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(Exit.isFailure(yield* auth.createInvitation(reader.token).pipe(Effect.exit))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("standard sessions can operate projects while access management remains admin-only", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const standard = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    expect(standard.scopes).toContain(AuthOrchestrationOperateScope);
    expect(standard.scopes).toContain(AuthFilesystemWriteScope);
    expect(Exit.isFailure(yield* auth.access(standard.token).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(
        yield* auth.revoke(standard.token, "session", owner.sessionId).pipe(Effect.exit),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("machine credentials are bound to one environment and cannot authenticate a client", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const invitation = yield* auth.createInvitation(owner.token, "Worker");
    const input = {
      credential: invitation.credential,
      environmentId: EnvironmentId.make("worker"),
      label: "Worker",
    };
    const machine = yield* auth.enroll(input);
    yield* auth.authenticateEnvironment(machine.token, "worker");
    expect(
      Exit.isFailure(
        yield* auth.authenticateEnvironment(machine.token, "another").pipe(Effect.exit),
      ),
    ).toBe(true);
    expect(Exit.isFailure(yield* auth.authenticate(machine.token).pipe(Effect.exit))).toBe(true);
    expect(Exit.isFailure(yield* auth.enroll(input).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(yield* auth.authenticateEnvironment(owner.token, "worker").pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("revocation invalidates clients and wakes their live connection watchers", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const client = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    const watcher = yield* auth.awaitInvalidation(client.sessionId).pipe(Effect.forkScoped);
    yield* auth.revoke(owner.token, "session", client.sessionId);
    yield* Fiber.join(watcher);
    expect(Exit.isFailure(yield* auth.authenticate(client.token).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(yield* auth.revoke(owner.token, "session", owner.sessionId).pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
