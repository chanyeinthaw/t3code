import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS } from "../chat/threadDetailsPanelStyles";
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "~/composerDraftStore";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "~/components/BranchToolbar.logic";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "~/components/ProjectScriptsControl";
import type { ComponentProps } from "react";
import { ThreadDetailsCard } from "~/components/chat/ThreadDetailsCard";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { ThreadAutomationsPanel } from "~/components/chat/ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "~/components/chat/ThreadRelationshipsControl";

export interface AgentDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  agentId: string;
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The thread's env mode as ChatView resolves it. */
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function AgentDetailsPanel(props: AgentDetailsPanelProps) {
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const environment = useEnvironment(props.environmentId);

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => (
        <>
          <ThreadDetailsSection
            headingId="thread-details-workspace-heading"
            title="Workspace"
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              <div className={`flex items-center ${THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS}`}>
                <EnvironmentMachineIcon
                  kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                  className={THREAD_DETAILS_PANEL_ICON_CLASS}
                />
                <span className="min-w-0 truncate">
                  {environment?.label ?? "Unavailable environment"}
                </span>
                {environment?.connection.phase !== "connected" ? (
                  <span className="ml-auto text-xs text-muted-foreground">Offline</span>
                ) : null}
              </div>

              {density !== "essential" && props.showOpenInPicker ? (
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={props.gitCwd}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts ? (
                <ProjectScriptsControl
                  environmentId={props.environmentId}
                  displayMode="panel"
                  scripts={props.activeProjectScripts}
                  fileScripts={fileScripts}
                  preferredScriptId={props.preferredScriptId}
                  onRunScript={props.onRunProjectScript}
                  onAddScript={props.onAddProjectScript}
                  onUpdateScript={props.onUpdateProjectScript}
                  onDeleteScript={props.onDeleteProjectScript}
                />
              ) : null}
            </div>
          </ThreadDetailsSection>

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
          <ThreadDetailsSection
            headingId="agent-details-configuration-heading"
            title="Agent configuration"
            showHeading={false}
          >
            <ThreadDetailsControl
              render={
                <Link
                  to="/settings/agents"
                  search={{ agent: props.agentId, machine: props.environmentId }}
                />
              }
            >
              <SettingsIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="min-w-0 truncate">Configure agent</span>
            </ThreadDetailsControl>
          </ThreadDetailsSection>
        </>
      )}
    </ThreadDetailsCard>
  );
}
