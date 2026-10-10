import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const OneChatSettings = Schema.Struct({
  environmentId: EnvironmentId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  additionalInstructions: Schema.String.check(Schema.isMaxLength(32000)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
});
export type OneChatSettings = typeof OneChatSettings.Type;
export const OneChatConfiguration = Schema.Struct({
  ...OneChatSettings.fields,
  threadId: ThreadId,
});
export type OneChatConfiguration = typeof OneChatConfiguration.Type;
export const OneChatState = Schema.NullOr(OneChatConfiguration);

/** Reserved threads stay out of project sidebars, including previous configurations. */
export function isAgentThread(threadId: string): boolean {
  return threadId.startsWith("one-chat:") || threadId.startsWith("agent:");
}

/** Internal backing records are hidden from project navigation. */
export function isAgentProject(projectId: string): boolean {
  return projectId.startsWith("one-chat:") || projectId.startsWith("agent:");
}

export const DEFAULT_AGENT_ID = "pulse";
export const DEFAULT_AGENT_NAME = "Pulse";

export const ONE_CHAT_INSTRUCTIONS_FILENAME = ".pulse-agent-instructions";

/** IDs are stable URL segments and directory names, never filesystem paths. */
export const AgentId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
export const AgentName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
export const AgentDefinition = Schema.Struct({
  id: AgentId,
  name: AgentName,
  configuration: OneChatState,
});
export type AgentDefinition = typeof AgentDefinition.Type;
export const AgentRegistry = Schema.Array(AgentDefinition);
export const AgentSettings = Schema.Struct({
  id: AgentId,
  name: AgentName,
  ...OneChatSettings.fields,
});
export type AgentSettings = typeof AgentSettings.Type;
