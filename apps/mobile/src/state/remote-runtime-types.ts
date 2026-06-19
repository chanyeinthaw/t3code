import type {
  EnvironmentConnection,
  EnvironmentConnectionState,
  WsRpcClient,
} from "@pulse/client-runtime";
import { EnvironmentId, ThreadId } from "@pulse/contracts";

export type { EnvironmentRuntimeState } from "@pulse/client-runtime";

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  readonly connectionState: EnvironmentConnectionState;
  readonly connectionError: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface EnvironmentSession {
  readonly client: WsRpcClient;
  readonly connection: EnvironmentConnection;
}
