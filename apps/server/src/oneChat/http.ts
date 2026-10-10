// @effect-diagnostics nodeBuiltinImport:off -- Adapt the hub's Node listener to its Effect services.
import type * as NodeHttp from "node:http";
import {
  AgentId,
  AgentRegistry,
  AgentSettings,
  OneChatSettings,
  OneChatState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HubAuth from "../hub/HubAuth.ts";
import { hubRequestToken, readHubRequestBody, sameOriginRequest } from "../hub/authHttp.ts";
import * as OneChat from "./OneChat.ts";

const encodeState = Schema.encodeEffect(Schema.fromJsonString(OneChatState));
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(OneChatSettings));

export const handleOneChat = Effect.fn("OneChatHttp.handle")(function* (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  service: OneChat.OneChat["Service"],
  publicOrigin?: string,
) {
  const auth = yield* HubAuth.HubAuth;
  const token = hubRequestToken(request, auth.cookieName);
  yield* auth.authenticate(token);
  let state;
  if (request.method === "GET") state = yield* service.read();
  else if (request.method === "PUT" || request.method === "DELETE") {
    if (!sameOriginRequest(request, publicOrigin))
      return yield* new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
    yield* auth.requireAdmin(token);
    const settings =
      request.method === "DELETE"
        ? null
        : yield* readHubRequestBody(request).pipe(
            Effect.flatMap(decodeSettings),
            Effect.mapError((cause) => new HubAuth.HubAuthError({ status: 400, cause })),
          );
    state = yield* service.configure(settings);
  } else {
    response.writeHead(405);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(yield* encodeState(state));
});

const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
const encodeAgents = Schema.encodeEffect(Schema.fromJsonString(AgentRegistry));
const decodeAgent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentSettings));

export const handleAgents = Effect.fn("AgentsHttp.handle")(function* (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  service: OneChat.OneChat["Service"],
  publicOrigin?: string,
) {
  const auth = yield* HubAuth.HubAuth;
  const token = hubRequestToken(request, auth.cookieName);
  yield* auth.authenticate(token);
  const url = new URL(request.url ?? "/", "http://hub.local");
  if (request.method === "PUT" || request.method === "DELETE" || request.method === "POST") {
    if (!sameOriginRequest(request, publicOrigin))
      return yield* new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
    yield* auth.requireAdmin(token);
    if (request.method === "PUT") {
      const settings = yield* readHubRequestBody(request).pipe(
        Effect.flatMap(decodeAgent),
        Effect.mapError((cause) => new HubAuth.HubAuthError({ status: 400, cause })),
      );
      yield* service.configureAgent(settings);
    } else {
      const id = yield* decodeAgentId(url.searchParams.get("id")).pipe(
        Effect.mapError((cause) => new HubAuth.HubAuthError({ status: 400, cause })),
      );
      yield* (request.method === "POST" ? service.resetAgent(id) : service.removeAgent(id)).pipe(
        Effect.catchTags({
          AgentMutationError: (cause) =>
            Effect.fail(
              new HubAuth.HubAuthError({ status: cause.reason === "not-found" ? 404 : 400, cause }),
            ),
        }),
      );
    }
  } else if (request.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(yield* encodeAgents(yield* service.listAgents()));
});
