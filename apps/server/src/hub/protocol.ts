import { HubPrincipal } from "./ingress.ts";
import * as Schema from "effect/Schema";
import WebSocket from "ws";

const id = Schema.String;
const headers = Schema.Record(Schema.String, Schema.String);
/** Multiplex existing HTTP and WebSocket traffic over one outbound environment connection. */
export const TunnelFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("register"), environmentId: id, label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("registered") }),
  Schema.Struct({
    type: Schema.Literal("http-open"),
    id,
    method: Schema.String,
    path: Schema.String,
    headers,
    principal: Schema.optionalKey(HubPrincipal),
  }),
  Schema.Struct({ type: Schema.Literal("http-head"), id, status: Schema.Number, headers }),
  Schema.Struct({ type: Schema.Literal("http-data"), id, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("http-end"), id }),
  Schema.Struct({ type: Schema.Literal("cancel"), id }),
  Schema.Struct({
    type: Schema.Literal("ws-open"),
    id,
    path: Schema.String,
    protocols: Schema.Array(Schema.String),
    principal: Schema.optionalKey(HubPrincipal),
  }),
  Schema.Struct({ type: Schema.Literal("ws-ready"), id }),
  Schema.Struct({
    type: Schema.Literal("ws-data"),
    id,
    data: Schema.String,
    binary: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("ws-close"), id }),
  Schema.Struct({ type: Schema.Literal("error"), id, message: Schema.String }),
]);
export type TunnelFrame = typeof TunnelFrame.Type;

export const MAX_TUNNEL_BUFFER = 8 * 1024 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Close an overloaded tunnel instead of retaining unbounded process memory. */
export function sendFrame(socket: WebSocket, frame: TunnelFrame): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_TUNNEL_BUFFER) {
    socket.close(1013, "Tunnel overloaded");
    return false;
  }
  socket.send(JSON.stringify(frame));
  return true;
}

export function sendHttpData(socket: WebSocket, id: string, chunk: Buffer) {
  for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
    if (
      !sendFrame(socket, {
        type: "http-data",
        id,
        data: chunk.subarray(offset, offset + 48 * 1024).toString("base64"),
      })
    )
      break;
  }
}

/** Only origin-relative paths may reach the environment's fixed loopback destination. */
export function localPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

const hopHeaders = new Set([
  "connection",
  "upgrade",
  "host",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);
export function forwardHeaders(input: Record<string, string | string[] | undefined>) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !hopHeaders.has(key.toLowerCase()))
      output[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}
