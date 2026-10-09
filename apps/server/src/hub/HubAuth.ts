import * as FileSystem from "effect/FileSystem";
import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthTerminalReadScope,
  AuthDiagnosticsReadScope,
  AuthRelayReadScope,
  AuthSessionId,
  type AuthClientMetadata,
  type HubAccessRole,
  type HubPairingInput,
  type HubEnrollmentInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SessionStore from "../auth/SessionStore.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { hubAuthConfig } from "./config.ts";

const readScopes = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthTerminalReadScope,
  AuthDiagnosticsReadScope,
  AuthRelayReadScope,
];
export const hubRoleScopes = (role: HubAccessRole) =>
  role === "admin"
    ? AuthAdministrativeScopes
    : role === "standard"
      ? AuthStandardClientScopes
      : readScopes;
export const hubSessionRole = (scopes: ReadonlyArray<string>): HubAccessRole =>
  scopes.includes(AuthAccessWriteScope)
    ? "admin"
    : scopes.includes("orchestration:operate")
      ? "standard"
      : "read-only";

export class HubAuthError extends Schema.TaggedError<HubAuthError>()("HubAuthError", {
  status: Schema.Number,
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.status === 403
      ? "Hub administrator access is required."
      : "Invalid or expired hub credential.";
  }
}

export class HubAuth extends Context.Service<
  HubAuth,
  {
    readonly cookieName: string;
    readonly authenticate: (
      token: string | undefined,
    ) => Effect.Effect<SessionStore.VerifiedSession, HubAuthError>;
    readonly authenticateEnvironment: (
      token: string | undefined,
      environmentId: string,
    ) => Effect.Effect<SessionStore.VerifiedSession, HubAuthError>;
    readonly exchange: (
      credential: string,
      metadata?: AuthClientMetadata,
    ) => Effect.Effect<SessionStore.VerifiedSession, HubAuthError>;
    readonly startup: () => Effect.Effect<string, HubAuthError>;
    readonly createPairing: (
      token: string | undefined,
      input: typeof HubPairingInput.Type,
    ) => Effect.Effect<EnvironmentAuth.IssuedPairingLink, HubAuthError>;
    readonly createInvitation: (
      token: string | undefined,
      label?: string,
    ) => Effect.Effect<EnvironmentAuth.IssuedPairingLink, HubAuthError>;
    readonly enroll: (
      input: typeof HubEnrollmentInput.Type,
    ) => Effect.Effect<SessionStore.IssuedSession, HubAuthError>;
    readonly enrollLocal: (
      environmentId: string,
      label: string,
    ) => Effect.Effect<SessionStore.IssuedSession, HubAuthError>;
    readonly access: (token: string | undefined) => Effect.Effect<
      {
        clients: ReadonlyArray<import("@t3tools/contracts").AuthClientSession>;
        pairingLinks: ReadonlyArray<import("@t3tools/contracts").AuthPairingLink>;
        environments: ReadonlyArray<import("@t3tools/contracts").AuthClientSession>;
        invitations: ReadonlyArray<import("@t3tools/contracts").AuthPairingLink>;
      },
      HubAuthError
    >;
    readonly revoke: (
      token: string | undefined,
      kind: "session" | "pairing",
      id: string,
    ) => Effect.Effect<void, HubAuthError>;
    readonly requireAdmin: (token: string | undefined) => Effect.Effect<void, HubAuthError>;
    readonly awaitInvalidation: SessionStore.SessionStore["Service"]["awaitInvalidation"];
    readonly issueTicket: SessionStore.SessionStore["Service"]["issueWebSocketToken"];
    readonly verifyTicket: SessionStore.SessionStore["Service"]["verifyWebSocketToken"];
    readonly markConnected: SessionStore.SessionStore["Service"]["markConnected"];
    readonly markDisconnected: SessionStore.SessionStore["Service"]["markDisconnected"];
  }
>()("t3/hub/HubAuth") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const fail = (cause: unknown) => new HubAuthError({ status: 401, cause });
  const authenticate = Effect.fn("HubAuth.authenticate")(function* (token: string | undefined) {
    if (!token) return yield* fail("Missing credential");
    const session = yield* sessions.verify(token).pipe(Effect.mapError(fail));
    if (session.subject.startsWith("hub-daemon:") || session.subject === "mcp-client")
      return yield* fail("Wrong credential audience");
    return session;
  });
  const requireAdmin = Effect.fn("HubAuth.requireAdmin")(function* (token: string | undefined) {
    const session = yield* authenticate(token);
    if (!session.scopes.includes(AuthAccessWriteScope))
      return yield* new HubAuthError({ status: 403, cause: "Missing access:write" });
  });
  // Persisted subjects keep their original names so existing enrollments remain valid.
  const issueEnvironment = Effect.fn("HubAuth.issueEnvironment")(function* (
    environmentId: string,
    label: string,
  ) {
    return yield* sessions
      .issue({
        method: "bearer-access-token",
        subject: `hub-daemon:${environmentId}`,
        scopes: [],
        ttl: Duration.days(3650),
        client: { label, deviceType: "unknown" },
        replaceActiveForSubjectAndMethod: true,
      })
      .pipe(Effect.mapError(fail));
  });
  return HubAuth.of({
    cookieName: sessions.cookieName,
    authenticate,
    requireAdmin,
    authenticateEnvironment: Effect.fn("HubAuth.authenticateEnvironment")(
      function* (token, environmentId) {
        if (!token) return yield* fail("Missing machine credential");
        const session = yield* sessions.verify(token).pipe(Effect.mapError(fail));
        if (session.subject !== `hub-daemon:${environmentId}`)
          return yield* fail("Wrong machine credential");
        return session;
      },
    ),
    exchange: Effect.fn("HubAuth.exchange")(function* (credential, metadata) {
      // The existing exchanger also supports the reusable dev and desktop bootstrap credentials.
      const issued = yield* auth
        .exchangeBootstrapCredentialForAccessToken(
          credential,
          undefined,
          metadata ?? { deviceType: "unknown" },
        )
        .pipe(Effect.mapError(fail));
      const session = yield* authenticate(issued.access_token);
      return session;
    }),
    startup: Effect.fn("HubAuth.startup")(function* () {
      return (yield* auth.issueStartupPairingCredential().pipe(Effect.mapError(fail))).credential;
    }),
    createPairing: Effect.fn("HubAuth.createPairing")(function* (token, input) {
      yield* requireAdmin(token);
      return yield* auth
        .createPairingLink({
          scopes: hubRoleScopes(input.role),
          ttl: Duration.minutes(input.ttlMinutes),
          ...(input.label ? { label: input.label } : {}),
        })
        .pipe(Effect.mapError(fail));
    }),
    createInvitation: Effect.fn("HubAuth.createInvitation")(function* (token, label) {
      yield* requireAdmin(token);
      return yield* auth
        .createPairingLink({
          scopes: [],
          subject: "hub-daemon-invitation",
          ttl: Duration.minutes(10),
          ...(label ? { label } : {}),
        })
        .pipe(Effect.mapError(fail));
    }),
    enroll: Effect.fn("HubAuth.enroll")(function* (input) {
      const grant = yield* grants.consume(input.credential).pipe(Effect.mapError(fail));
      if (grant.subject !== "hub-daemon-invitation")
        return yield* fail("An environment invitation is required");
      return yield* issueEnvironment(input.environmentId, input.label);
    }),
    enrollLocal: issueEnvironment,
    access: Effect.fn("HubAuth.access")(function* (token) {
      yield* requireAdmin(token);
      const all = yield* sessions.listActive().pipe(Effect.mapError(fail));
      const links = yield* grants.listActive().pipe(Effect.mapError(fail));
      return {
        clients: all.filter(
          (s) => !s.subject.startsWith("hub-daemon:") && s.subject !== "mcp-client",
        ),
        environments: all.filter((s) => s.subject.startsWith("hub-daemon:")),
        pairingLinks: links.filter((g) => g.subject !== "hub-daemon-invitation"),
        invitations: links.filter((g) => g.subject === "hub-daemon-invitation"),
      };
    }),
    revoke: Effect.fn("HubAuth.revoke")(function* (token, kind, id) {
      const current = yield* authenticate(token);
      yield* requireAdmin(token);
      if (kind === "session" && id === current.sessionId)
        return yield* new HubAuthError({ status: 403, cause: "Cannot revoke current session" });
      if (kind === "session")
        yield* sessions.revoke(AuthSessionId.make(id)).pipe(Effect.mapError(fail));
      else yield* grants.revoke(id).pipe(Effect.mapError(fail));
    }),
    awaitInvalidation: sessions.awaitInvalidation,
    issueTicket: sessions.issueWebSocketToken,
    verifyTicket: sessions.verifyWebSocketToken,
    markConnected: sessions.markConnected,
    markDisconnected: sessions.markDisconnected,
  });
});

export const layer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const hubConfig = hubAuthConfig(config);
      yield* fs.makeDirectory(hubConfig.stateDir, { recursive: true });
      return Layer.effect(HubAuth, make).pipe(
        Layer.provide(EnvironmentAuth.layerRuntime),
        Layer.provide(ServerConfig.layer(hubConfig)),
        Layer.fresh,
      );
    }),
  );
