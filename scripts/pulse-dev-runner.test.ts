import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

it.layer(NodeServices.layer)("Pulse development home isolation", (it) => {
  it.effect.each([
    { selection: "worktree", explicit: false, worktree: true },
    { selection: "explicit", explicit: true, worktree: true },
    { selection: "ambient", explicit: false, worktree: false },
  ])("uses the $selection home without starting a server", ({ selection, explicit, worktree }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-dev-home-" });
      if (worktree) {
        yield* fs.writeFileString(path.join(root, ".git"), "gitdir: /elsewhere/worktrees/test\n");
      }
      const explicitHome = path.join(root, "explicit");
      const ambientHome = path.join(root, "ambient");
      const unrelatedHome = path.join(root, "unrelated-t3");
      const output = yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          [
            path.join(import.meta.dirname, "pulse-dev-runner.ts"),
            "dev:server",
            "--dry-run",
            "--port",
            "4222",
            ...(explicit ? ["--home-dir", explicitHome] : []),
          ],
          {
            cwd: root,
            env: { PULSE_HOME: ambientHome, T3CODE_HOME: unrelatedHome },
          },
        ),
      );
      const expectedHome =
        selection === "worktree"
          ? path.join(root, ".t3")
          : selection === "explicit"
            ? explicitHome
            : ambientHome;
      assert.include(output, `baseDir=${expectedHome}`);
      assert.equal(yield* fs.exists(path.join(expectedHome, "userdata")), false);
      assert.equal(yield* fs.exists(path.join(unrelatedHome, "userdata")), false);
    }).pipe(Effect.scoped),
  );
});
