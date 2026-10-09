// @effect-diagnostics globalFetchInEffect:off globalFetch:off -- Exercise the hub's public HTTP listener.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "./HubAuth.ts";
import * as HubServer from "./HubServer.ts";

it.effect("serves the hub client with compression, build caching, revalidation, and HEAD", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-hub-web-" });
    yield* fs.makeDirectory(path.join(staticDir, "assets"));
    yield* fs.makeDirectory(path.join(staticDir, ".vite"));
    const source = "export const message = 'hello';\n".repeat(2048);
    yield* fs.writeFileString(path.join(staticDir, "assets", "main-12345678.js"), source);
    yield* fs.writeFileString(path.join(staticDir, "assets", "custom-12345678.js"), source);
    yield* fs.writeFileString(path.join(staticDir, "index.html"), "<html>Pulse</html>");
    yield* fs.writeFileString(
      path.join(staticDir, ".vite", "manifest.json"),
      JSON.stringify({
        "main.ts": { file: "assets/main-12345678.js" },
      }),
    );
    const hub = yield* HubServer.HubServer;
    const { port } = yield* hub.listen({ host: "127.0.0.1", port: 0, staticDir });
    const origin = `http://127.0.0.1:${port}`;
    const request = (resource: string, options?: RequestInit) =>
      Effect.promise(() => fetch(`${origin}${resource}`, options));
    const asset = yield* request("/assets/main-12345678.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("vary")).toContain("Accept-Encoding");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(yield* Effect.promise(() => asset.text())).toBe(source);
    const etag = asset.headers.get("etag");
    expect(etag).toBeTruthy();
    const cached = yield* request("/assets/main-12345678.js", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
    expect(yield* Effect.promise(() => cached.text())).toBe("");
    const head = yield* request("/assets/main-12345678.js", {
      method: "HEAD",
      headers: { "accept-encoding": "gzip" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect(yield* Effect.promise(() => head.text())).toBe("");
    const custom = yield* request("/assets/custom-12345678.js");
    expect(custom.headers.get("cache-control")).toBe("no-cache");
    yield* Effect.promise(() => custom.arrayBuffer());
    const html = yield* request("/settings/agents", { headers: { "if-none-match": "*" } });
    expect(html.status).toBe(200);
    expect(html.headers.get("cache-control")).toBe("no-cache");
    expect(yield* Effect.promise(() => html.text())).toBe("<html>Pulse</html>");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      HubServer.layer.pipe(
        Layer.provideMerge(
          Layer.unwrap(Effect.map(ServerConfig.ServerConfig, HubAuth.layer)).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "pulse-hub-web-auth-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);
