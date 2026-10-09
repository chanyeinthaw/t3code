import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expandHomePath } from "../os-jank.ts";

// Pulse state is separate from upstream T3, including when no home is configured.
export const resolvePulseBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(yield* HostProcess.HomeDirectory, ".pulse");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
