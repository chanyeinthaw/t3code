// @effect-diagnostics nodeBuiltinImport:off -- Node transport streams serve the hub's web bundle and Vite proxy.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { makeStaticAndDevRoute, layerHttpCompression } from "../http.ts";
import WebSocket from "ws";
import { forwardHeaders, MAX_TUNNEL_BUFFER } from "./protocol.ts";

export function proxyHubWebRequest(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  devUrl: string,
) {
  const target = new URL(request.url ?? "/", devUrl);
  const upstream = (target.protocol === "https:" ? NodeHttps : NodeHttp).request(
    target,
    { method: request.method, headers: forwardHeaders(request.headers) },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, forwardHeaders(incoming.headers));
      incoming.pipe(response);
      incoming.on("error", () => response.destroy());
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Web dev server unavailable");
  });
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}

export function proxyHubWebSocket(
  client: WebSocket,
  request: NodeHttp.IncomingMessage,
  devUrl: string,
  owned: Set<WebSocket>,
) {
  const target = new URL(request.url ?? "/", devUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(
    target,
    request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? [],
    {
      headers: Object.fromEntries(
        Object.entries(forwardHeaders(request.headers)).filter(
          ([key]) =>
            ![
              "sec-websocket-key",
              "sec-websocket-version",
              "sec-websocket-protocol",
              "sec-websocket-extensions",
            ].includes(key),
        ),
      ),
    },
  );
  owned.add(upstream);
  const waiting: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  let waitingBytes = 0;
  upstream.on("open", () => {
    for (const { data, binary } of waiting) upstream.send(data, { binary });
    waiting.length = 0;
    waitingBytes = 0;
  });
  client.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      waitingBytes += Array.isArray(data)
        ? data.reduce((size, part) => size + part.length, 0)
        : data.byteLength;
      if (waitingBytes > MAX_TUNNEL_BUFFER) client.close(1013, "Client overloaded");
      else waiting.push({ data, binary });
    } else if (upstream.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount > MAX_TUNNEL_BUFFER) client.close(1013, "Client overloaded");
      else upstream.send(data, { binary });
    }
  });
  upstream.on("message", (data, binary) => {
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_TUNNEL_BUFFER)
      client.send(data, { binary });
  });
  upstream.on("error", () => client.close(1011, "Web dev server unavailable"));
  upstream.on("close", () => {
    owned.delete(upstream);
    client.close();
  });
  client.on("close", () => upstream.terminate());
  client.on("error", () => client.terminate());
}

/** Share the environment's static serving and compression without starting a second HTTP listener. */
export const makeHubWebHandler = Effect.fn("HubWeb.makeHandler")(function* (staticDir: string) {
  const scope = yield* Effect.scope;
  const app = yield* HttpRouter.toHttpEffect(
    Layer.merge(makeStaticAndDevRoute({ staticDir, devUrl: undefined }), layerHttpCompression),
  );
  return yield* NodeHttpServer.makeHandler(app, { scope });
}, Effect.provide(NodeHttpServer.layerHttpServices));
