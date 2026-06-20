import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@pulse/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "@sats-lab/pulse/environment/Services/ServerEnvironment",
) {}
