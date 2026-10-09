import { HUB_INGRESS_HEADER, signHubIngress } from "./ingress.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Node streams and upgrades implement the raw multiplexed transport.
// @effect-diagnostics globalTimers:off -- WebSocket heartbeat and local request deadlines belong to this transport scope.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import WebSocket from "ws";
import { HubTransportError } from "./HubServer.ts";
import {
  TunnelFrame,
  forwardHeaders,
  localPath,
  MAX_FRAME_BYTES,
  MAX_TUNNEL_BUFFER,
  sendFrame,
  sendHttpData,
} from "./protocol.ts";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(TunnelFrame));

/** One connection attempt; the CLI owns reconnect scheduling and interruption. */
export const connectEnvironment = Effect.fn("EnvironmentTunnel.connect")(function* (options: {
  readonly hubUrl: string;
  readonly localPort: number;
  readonly environmentId: string;
  readonly label: string;
  readonly credential?: string | undefined;
  readonly ingressSecret?: string;
  readonly onRegistered?: () => void;
}) {
  const hub = new URL(options.hubUrl);
  hub.protocol = hub.protocol === "https:" ? "wss:" : "ws:";
  // Retain the established wire path so environments can join older hubs.
  hub.pathname = "/hub/daemon";
  hub.search = "";
  hub.searchParams.set("environmentId", options.environmentId);
  hub.hash = "";
  const tunnel = new WebSocket(hub, {
    maxPayload: MAX_FRAME_BYTES,
    handshakeTimeout: 10_000,
    ...(options.credential ? { headers: { authorization: `Bearer ${options.credential}` } } : {}),
  });
  const requests = new Map<string, NodeHttp.ClientRequest>();
  const sockets = new Map<string, WebSocket>();
  const waiting = new Map<string, Array<{ data: string; binary: boolean }>>();
  const fail = (id: string) =>
    sendFrame(tunnel, { type: "error", id, message: "Local environment request failed." });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      tunnel.terminate();
      for (const request of requests.values()) request.destroy();
      for (const socket of sockets.values()) socket.terminate();
    }),
  );
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((_resolve, reject) => {
        tunnel.on("open", () =>
          sendFrame(tunnel, {
            type: "register",
            environmentId: options.environmentId,
            label: options.label,
          }),
        );
        tunnel.on("error", reject);
        tunnel.on("close", () => reject(new Error("Hub connection closed")));
        tunnel.on("message", (data) => {
          const decoded = decodeFrame(data.toString());
          if (decoded._tag === "None") {
            tunnel.close(1008, "Invalid tunnel frame");
            return;
          }
          const frame = decoded.value;
          switch (frame.type) {
            case "registered":
              options.onRegistered?.();
              break;
            case "http-open": {
              if (!localPath(frame.path) || requests.has(frame.id)) {
                fail(frame.id);
                break;
              }
              const request = NodeHttp.request(
                {
                  hostname: "127.0.0.1",
                  port: options.localPort,
                  method: frame.method,
                  path: frame.path,
                  headers: {
                    ...forwardHeaders(frame.headers),
                    ...(options.ingressSecret && frame.principal
                      ? {
                          [HUB_INGRESS_HEADER]: signHubIngress(
                            options.ingressSecret,
                            frame.principal,
                            frame.method,
                            frame.path,
                          ),
                        }
                      : {}),
                  },
                },
                (response) => {
                  sendFrame(tunnel, {
                    type: "http-head",
                    id: frame.id,
                    status: response.statusCode ?? 502,
                    headers: forwardHeaders(response.headers),
                  });
                  response.on("data", (chunk: Buffer) => sendHttpData(tunnel, frame.id, chunk));
                  response.on("end", () => {
                    requests.delete(frame.id);
                    sendFrame(tunnel, { type: "http-end", id: frame.id });
                  });
                  response.on("error", () => {
                    requests.delete(frame.id);
                    fail(frame.id);
                  });
                },
              );
              request.on("error", () => {
                requests.delete(frame.id);
                fail(frame.id);
              });
              requests.set(frame.id, request);
              break;
            }
            case "http-data": {
              const request = requests.get(frame.id);
              request?.write(Buffer.from(frame.data, "base64"));
              if (request && request.writableLength > MAX_TUNNEL_BUFFER) {
                request.destroy();
                requests.delete(frame.id);
                fail(frame.id);
              }
              break;
            }
            case "http-end":
              requests.get(frame.id)?.end();
              break;
            case "cancel":
              requests.get(frame.id)?.destroy();
              requests.delete(frame.id);
              break;
            case "ws-open": {
              if (!localPath(frame.path) || sockets.has(frame.id)) {
                fail(frame.id);
                break;
              }
              const socket = new WebSocket(
                `ws://127.0.0.1:${options.localPort}${frame.path}`,
                [...frame.protocols],
                {
                  maxPayload: MAX_FRAME_BYTES,
                  handshakeTimeout: 10_000,
                  ...(options.ingressSecret && frame.principal
                    ? {
                        headers: {
                          [HUB_INGRESS_HEADER]: signHubIngress(
                            options.ingressSecret,
                            frame.principal,
                            "GET",
                            frame.path,
                          ),
                        },
                      }
                    : {}),
                },
              );
              sockets.set(frame.id, socket);
              waiting.set(frame.id, []);
              socket.on("open", () => {
                for (const item of waiting.get(frame.id) ?? [])
                  socket.send(Buffer.from(item.data, "base64"), { binary: item.binary });
                waiting.delete(frame.id);
                sendFrame(tunnel, { type: "ws-ready", id: frame.id });
              });
              socket.on("message", (data, binary) =>
                sendFrame(tunnel, {
                  type: "ws-data",
                  id: frame.id,
                  data: Buffer.from(
                    data instanceof ArrayBuffer
                      ? new Uint8Array(data)
                      : Array.isArray(data)
                        ? Buffer.concat(data)
                        : data,
                  ).toString("base64"),
                  binary,
                }),
              );
              socket.on("error", () => {
                fail(frame.id);
                socket.terminate();
              });
              socket.on("close", () => {
                sockets.delete(frame.id);
                waiting.delete(frame.id);
                sendFrame(tunnel, { type: "ws-close", id: frame.id });
              });
              break;
            }
            case "ws-data": {
              const socket = sockets.get(frame.id);
              if (socket?.readyState === WebSocket.OPEN) {
                if (socket.bufferedAmount > MAX_TUNNEL_BUFFER)
                  socket.close(1013, "Local socket overloaded");
                else socket.send(Buffer.from(frame.data, "base64"), { binary: frame.binary });
              } else {
                const queue = waiting.get(frame.id);
                if (
                  queue &&
                  queue.reduce((size, item) => size + item.data.length, 0) + frame.data.length <
                    MAX_TUNNEL_BUFFER
                )
                  queue.push(frame);
                else socket?.terminate();
              }
              break;
            }
            case "ws-close":
              sockets.get(frame.id)?.terminate();
              sockets.delete(frame.id);
              waiting.delete(frame.id);
              break;
          }
        });
        // The connection lives until close/error or interruption, not until registration.
      }),
    catch: (cause) => new HubTransportError({ cause }),
  });
});
