// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The loopback bridge uses Node HMAC and constant-time verification.
import * as NodeCrypto from "node:crypto";
import { AuthEnvironmentScopes, AuthSessionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const HubPrincipal = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
});
export type HubPrincipal = typeof HubPrincipal.Type;
const IngressClaims = Schema.Struct({
  ...HubPrincipal.fields,
  method: Schema.String,
  path: Schema.String,
  expires: Schema.Number,
});
const decodeIngress = Schema.decodeSync(Schema.fromJsonString(IngressClaims));
export const HUB_INGRESS_HEADER = "x-t3-hub-ingress";

/** Only the environment's tunnel bridge knows this per-launch secret; client headers never carry identity. */
export function signHubIngress(
  secret: string,
  principal: HubPrincipal,
  method: string,
  path: string,
) {
  const payload = Buffer.from(
    JSON.stringify({ ...principal, method, path, expires: Date.now() + 30_000 }),
  ).toString("base64url");
  return `${payload}.${NodeCrypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyHubIngress(
  secret: string,
  token: string | undefined,
  method: string,
  path: string,
): HubPrincipal | undefined {
  if (!token) return;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return;
  const expected = NodeCrypto.createHmac("sha256", secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected)) return;
  try {
    const claims = decodeIngress(Buffer.from(parts[0], "base64url").toString());
    if (
      claims.expires < Date.now() ||
      claims.expires > Date.now() + 30_000 ||
      claims.method !== method ||
      claims.path !== path
    )
      return;
    return { sessionId: claims.sessionId, subject: claims.subject, scopes: claims.scopes };
  } catch {
    return;
  }
}
