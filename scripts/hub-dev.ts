// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off -- This CLI wrapper owns child process groups and shutdown deadlines.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { shareDevServer, unshareDevServer } from "./lib/dev-share.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Each process uses this worktree; the environment never opens the daily-driver database.
const platform = await Effect.runPromise(HostProcess.Platform);
const cwd = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const hubPort = process.env.T3_HUB_PORT ?? "4790";
const webPort = process.env.T3_WEB_PORT ?? "4792";
const host = process.env.T3_HUB_HOST ?? "localhost";
const shared = process.argv.includes("--share")
  ? await Effect.runPromise(
      shareDevServer({ webPort: Number(hubPort) }).pipe(Effect.provide(NodeServices.layer)),
    )
  : undefined;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  T3CODE_SINGLE_ORIGIN_DEV: "1",
  PULSE_HOME: `${cwd}/.t3/hub`,
  T3CODE_PORT: hubPort,
  PORT: webPort,
};
// A dev child is not the installed service launcher's IPC child.
for (const key of [
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
  "T3CODE_BOOTSTRAP_FD",
  "T3CODE_DESKTOP_CONTROL_FD",
]) {
  delete env[key];
}
const children = [
  NodeChildProcess.spawn(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "serve",
      "--base-dir",
      `${cwd}/.t3/hub`,
      "--host",
      host,
      "--port",
      hubPort,
      "--dev-url",
      `http://localhost:${webPort}`,
    ],
    {
      cwd,
      env,
      stdio: "inherit",
      detached: platform !== "win32",
    },
  ),
  NodeChildProcess.spawn("pnpm", ["--filter", "@t3tools/web", "dev"], {
    cwd,
    env,
    stdio: "inherit",
    detached: platform !== "win32",
  }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (platform === "win32") child.kill("SIGTERM");
    else if (child.pid && child.exitCode === null && child.signalCode === null) {
      const pid = child.pid;
      const deadline = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            console.error(error);
        }
      }, 5_000);
      child.once("exit", () => clearTimeout(deadline));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          console.error(error);
      }
    }
  }
  if (shared) {
    void Effect.runPromise(
      unshareDevServer(Number(hubPort)).pipe(Effect.provide(NodeServices.layer)),
    ).then((result) => {
      if (!result.cleared)
        console.error(`[hub-dev] Could not remove tailnet mapping on ${hubPort}`);
    });
  }
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
console.log(
  `[hub-dev] pairingUrl: ${shared?.url ?? `http://${host}:${hubPort}`}/; environment state: ${cwd}/.t3/hub`,
);
