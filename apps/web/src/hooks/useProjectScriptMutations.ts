import {
  type EnvironmentId,
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { type NewProjectScriptInput } from "~/components/ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { readEnvironmentApi } from "~/environmentApi";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { newCommandId } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";

export interface UseProjectScriptMutationsInput {
  readonly project:
    | { readonly id: ProjectId; readonly cwd: string; readonly scripts: ProjectScript[] }
    | null
    | undefined;
  readonly environmentId: EnvironmentId;
}

export function useProjectScriptMutations({
  project,
  environmentId,
}: UseProjectScriptMutationsInput) {
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        const localApi = readLocalApi();
        if (!localApi) {
          throw new Error("Local API unavailable.");
        }
        await localApi.server.upsertKeybinding(keybindingRule);
      }
    },
    [environmentId],
  );

  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!project) return;
      const nextId = nextProjectScriptId(
        input.name,
        project.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
        ...(input.autoOpenPreview ? { autoOpenPreview: input.autoOpenPreview } : {}),
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...project.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...project.scripts, nextScript];

      await persistProjectScripts({
        projectId: project.id,
        projectCwd: project.cwd,
        previousScripts: project.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [project, persistProjectScripts],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!project) return;
      const existingScript = project.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        ...(input.previewUrl ? { previewUrl: input.previewUrl } : { previewUrl: undefined }),
        ...(input.autoOpenPreview
          ? { autoOpenPreview: input.autoOpenPreview }
          : { autoOpenPreview: undefined }),
      };
      const nextScripts = project.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: project.id,
        projectCwd: project.cwd,
        previousScripts: project.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [project, persistProjectScripts],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!project) return;
      const nextScripts = project.scripts.filter((script) => script.id !== scriptId);
      const deletedName = project.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: project.id,
          projectCwd: project.cwd,
          previousScripts: project.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    },
    [project, persistProjectScripts],
  );

  return {
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
  };
}
