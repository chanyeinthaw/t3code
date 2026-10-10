import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  AgentId,
  CommandId,
  ProjectId,
  ONE_CHAT_INSTRUCTIONS_FILENAME,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class OneChatWorkspaceError extends Schema.TaggedError<OneChatWorkspaceError>()(
  "OneChatWorkspaceError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not prepare the agent directory.";
  }
}

const decodeAgentId = Schema.decodeUnknownEffect(AgentId);

/** Orchestration requires a backing project; users never select or navigate this internal record. */
export const ensureWorkspace = Effect.fn("OneChat.ensureWorkspace")(
  function* (input: { readonly agentId?: string; readonly additionalInstructions?: string }) {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const agentId = yield* decodeAgentId(
      input.agentId === "one-chat" ? DEFAULT_AGENT_ID : (input.agentId ?? DEFAULT_AGENT_ID),
    );
    const projectId = ProjectId.make(
      agentId === DEFAULT_AGENT_ID ? "one-chat:workspace" : `agent:${agentId}:workspace`,
    );
    const workspaceRoot = path.join(config.baseDir, "agents", agentId);
    const legacyAgentRoot = path.join(config.baseDir, "agents", "one-chat");
    const oldRoot =
      agentId === DEFAULT_AGENT_ID && (yield* fs.exists(legacyAgentRoot))
        ? legacyAgentRoot
        : path.join(config.baseDir, "one-chat");
    if (
      agentId === DEFAULT_AGENT_ID &&
      !(yield* fs.exists(workspaceRoot)) &&
      (yield* fs.exists(oldRoot))
    ) {
      yield* fs.makeDirectory(path.dirname(workspaceRoot), { recursive: true });
      yield* fs.rename(oldRoot, workspaceRoot);
    }
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    const existing = yield* projects.getById(projectId);
    if (
      Option.isSome(existing) &&
      (existing.value.workspaceRoot === oldRoot || existing.value.workspaceRoot === legacyAgentRoot)
    ) {
      yield* projects.update({
        commandId: CommandId.make(`${projectId}:agents:${DEFAULT_AGENT_ID}`),
        projectId: existing.value.id,
        workspaceRoot,
      });
    }
    // Dev homes may sit inside a checkout; prevent inheriting that repository's checkpoints.
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const repository = yield* registry.detect({ cwd: workspaceRoot });
    if (
      repository &&
      path.resolve(repository.repository.rootPath) !== path.resolve(workspaceRoot)
    ) {
      const git = yield* GitVcsDriver.GitVcsDriver;
      yield* git.initRepo({ cwd: workspaceRoot });
    }
    const result = yield* projects
      .bootstrap({
        commandId: CommandId.make(projectId),
        projectId,
        title: agentId === DEFAULT_AGENT_ID ? DEFAULT_AGENT_NAME : agentId,
        workspaceRoot,
      })
      .pipe(
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId } }),
        }),
      );
    if (input.additionalInstructions !== undefined) {
      const file = path.join(workspaceRoot, ONE_CHAT_INSTRUCTIONS_FILENAME);
      const temporary = yield* fs.makeTempFile({
        directory: workspaceRoot,
        prefix: ".agent-instructions-",
      });
      yield* fs.writeFileString(temporary, input.additionalInstructions);
      yield* fs.rename(temporary, file);
    }
    return { projectId: result.project.id, workspaceRoot };
  },
  Effect.mapError((cause) => new OneChatWorkspaceError({ cause })),
);
