import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
// @effect-diagnostics nodeBuiltinImport:off -- This adapter bridges the hub's native Node listener to Effect services.
import type * as NodeHttp from "node:http";
import { HubCredentialInput, HubEnrollmentInput, HubPairingInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as HubAuth from "./HubAuth.ts";

export function hubRequestToken(request: NodeHttp.IncomingMessage, cookieName: string) {
  if (request.headers.authorization !== undefined)
    return /^Bearer (.+)$/i.exec(request.headers.authorization)?.[1];
  return request.headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
}
export function sameOriginRequest(request: NodeHttp.IncomingMessage, publicOrigin?: string) {
  const origin = request.headers.origin;
  if (!origin) return true; // CLI/native credentials do not use browser Origin.
  try {
    const url = new URL(origin);
    return url.origin === publicOrigin || url.host === request.headers.host;
  } catch {
    return false;
  }
}
const readBody = (request: NodeHttp.IncomingMessage) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 4096) {
            reject(new Error("Request too large"));
            request.destroy();
          }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
        request.resume();
      }),
    catch: (cause) => new HubAuth.HubAuthError({ status: 400, cause }),
  });
const decodeBody = <S extends Schema.Top>(request: NodeHttp.IncomingMessage, schema: S) =>
  readBody(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((cause) => new HubAuth.HubAuthError({ status: 400, cause })),
  );
const LabelInput = Schema.Struct({ label: Schema.optionalKey(Schema.String) });
const RevokeInput = Schema.Struct({
  kind: Schema.Literals(["session", "pairing"]),
  id: Schema.String,
});
/** Routes decode input and call the hub auth service; environment auth endpoints are never exposed here. */
export const handleHubAuth = Effect.fn("HubAuthHttp.handle")(function* (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  path: string,
  publicOrigin?: string,
) {
  const auth = yield* HubAuth.HubAuth;
  const token = hubRequestToken(request, auth.cookieName);
  const json = (value: unknown) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  if (request.method !== "GET" && !sameOriginRequest(request, publicOrigin))
    return yield* new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
  if (path === "/hub/auth/session" && request.method === "GET") {
    const session = yield* auth.authenticate(token).pipe(Effect.option);
    if (session._tag === "None") json({ authenticated: false });
    else
      json({
        authenticated: true,
        role: HubAuth.hubSessionRole(session.value.scopes),
        sessionId: session.value.sessionId,
      });
  } else if (path === "/hub/auth/pair" && request.method === "POST") {
    const input = yield* decodeBody(request, HubCredentialInput);
    const metadata = deriveAuthClientMetadata({
      request: HttpServerRequest.fromWeb(
        new Request("http://hub", {
          headers: request.headers["user-agent"]
            ? { "user-agent": request.headers["user-agent"] }
            : {},
        }),
      ),
    });
    const session = yield* auth.exchange(input.credential, metadata);
    const secure =
      publicOrigin?.startsWith("https:") ||
      request.headers["x-forwarded-proto"] === "https" ||
      request.headers.origin?.startsWith("https:");
    response.setHeader(
      "set-cookie",
      `${auth.cookieName}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`,
    );
    json({
      authenticated: true,
      role: HubAuth.hubSessionRole(session.scopes),
      sessionId: session.sessionId,
      token: session.token,
      cookieName: auth.cookieName,
    });
  } else if (path === "/hub/auth/pairing" && request.method === "POST") {
    const issued = yield* auth.createPairing(token, yield* decodeBody(request, HubPairingInput));
    json({
      ...issued,
      createdAt: DateTime.formatIso(issued.createdAt),
      expiresAt: DateTime.formatIso(issued.expiresAt),
    });
  } else if (path === "/hub/auth/invitations" && request.method === "POST") {
    const input = yield* decodeBody(request, LabelInput);
    const issued = yield* auth.createInvitation(token, input.label);
    json({ ...issued, expiresAt: DateTime.formatIso(issued.expiresAt) });
  } else if (path === "/hub/auth/enroll" && request.method === "POST") {
    const session = yield* auth.enroll(yield* decodeBody(request, HubEnrollmentInput));
    json({ credential: session.token });
  } else if (path === "/hub/auth/access" && request.method === "GET") {
    const access = yield* auth.access(token);
    const environments = access.environments.map((s) => ({
      sessionId: s.sessionId,
      environmentId: s.subject.slice("hub-daemon:".length),
      label: s.client.label ?? s.subject.slice("hub-daemon:".length),
    }));
    const current = yield* auth.authenticate(token);
    json({
      clients: access.clients.map((s) => ({
        ...s,
        role: HubAuth.hubSessionRole(s.permissions ?? s.scopes),
        current: s.sessionId === current.sessionId,
        issuedAt: DateTime.formatIso(s.issuedAt),
        expiresAt: DateTime.formatIso(s.expiresAt),
        lastConnectedAt: s.lastConnectedAt ? DateTime.formatIso(s.lastConnectedAt) : null,
      })),
      environments,
      // Existing clients still read this field.
      daemons: environments,
      pairingLinks: access.pairingLinks.map((g) => ({
        ...g,
        role: HubAuth.hubSessionRole(g.permissions ?? g.scopes),
        createdAt: DateTime.formatIso(g.createdAt),
        expiresAt: DateTime.formatIso(g.expiresAt),
      })),
      invitations: access.invitations.map((g) => ({
        id: g.id,
        label: g.label,
        expiresAt: DateTime.formatIso(g.expiresAt),
      })),
    });
  } else if (path === "/hub/auth/revoke" && request.method === "POST") {
    const input = yield* decodeBody(request, RevokeInput);
    yield* auth.revoke(token, input.kind, input.id);
    json({});
  } else if (path === "/api/auth/websocket-ticket" && request.method === "POST") {
    const session = yield* auth.authenticate(token);
    const ticket = yield* auth.issueTicket(session.sessionId);
    json({ ticket: ticket.token, expiresAt: DateTime.formatIso(ticket.expiresAt) });
  } else {
    response.writeHead(404);
    response.end();
  }
});
