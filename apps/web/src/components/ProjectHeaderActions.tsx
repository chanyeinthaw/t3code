import type {
  EditorId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { memo } from "react";

import GitActionsControl from "./GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { OpenInPicker } from "./chat/OpenInPicker";

interface ProjectHeaderActionsProps {
  gitCwd: string | null;
  gitThreadRef: ScopedThreadRef | null;
  scripts: ProjectScript[] | undefined;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  preferredScriptId?: string | null;
  showOpenInPicker?: boolean;
  draftId?: DraftId | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteProjectScript: (scriptId: string) => Promise<void> | void;
}

export const ProjectHeaderActions = memo(function ProjectHeaderActions({
  gitCwd,
  gitThreadRef,
  scripts,
  keybindings,
  availableEditors,
  preferredScriptId = null,
  showOpenInPicker = false,
  draftId,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ProjectHeaderActionsProps) {
  return (
    <>
      {scripts && (
        <ProjectScriptsControl
          scripts={scripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          onRunScript={onRunProjectScript}
          onAddScript={onAddProjectScript}
          onUpdateScript={onUpdateProjectScript}
          onDeleteScript={onDeleteProjectScript}
        />
      )}
      {showOpenInPicker && (
        <OpenInPicker
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={gitCwd}
        />
      )}
      {gitThreadRef && (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={gitThreadRef}
          {...(draftId ? { draftId } : {})}
        />
      )}
    </>
  );
});
