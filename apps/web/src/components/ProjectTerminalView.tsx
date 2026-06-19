import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { scopeThreadRef } from "@pulse/client-runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@pulse/contracts";
import { nextTerminalId } from "@pulse/shared/terminalLabels";
import { projectScriptRuntimeEnv } from "@pulse/shared/projectScripts";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { ProjectHeaderActions } from "./ProjectHeaderActions";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useLastInvokedProjectScript } from "../hooks/useLastInvokedProjectScript";
import { useProjectScriptMutations } from "../hooks/useProjectScriptMutations";
import { projectTerminalThreadId } from "../lib/projectTerminal";
import { buildOwnerScopedTerminalLabels } from "../lib/terminalOwnerLabels";
import { useServerAvailableEditors } from "../rpc/serverState";
import { selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../terminalSessionState";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

interface ProjectTerminalViewProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  keybindings: ResolvedKeybindingsConfig;
}

const PROJECT_TERMINAL_HEIGHT = 10_000;
const PROJECT_TERMINAL_SCRIPT_COLS = 120;
const PROJECT_TERMINAL_SCRIPT_ROWS = 30;

const ProjectTerminalHeader = memo(function ProjectTerminalHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header
      className={cn(
        "@container/header-actions flex h-[52px] shrink-0 items-center border-b border-border px-3 sm:px-5",
        isElectron && "wco:h-[env(titlebar-area-height)]",
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium text-foreground" title={title}>
          {title}
        </h2>
      </div>
      {children ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 @3xl/header-actions:gap-3">
          {children}
        </div>
      ) : null}
    </header>
  );
});

const ProjectTerminalView = memo(function ProjectTerminalView({
  environmentId,
  projectId,
  keybindings,
}: ProjectTerminalViewProps) {
  const project = useStore((state) => selectProjectByRef(state, { environmentId, projectId }));
  const terminalThreadId = useMemo(() => projectTerminalThreadId(projectId), [projectId]);
  const terminalThreadRef = useMemo(
    () => scopeThreadRef(environmentId, terminalThreadId),
    [environmentId, terminalThreadId],
  );
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, terminalThreadRef),
  );
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId,
    threadId: terminalThreadId,
  });
  const serverOrderedTerminalIds = useMemo(
    () => knownTerminalSessions.map((session) => session.target.terminalId),
    [knownTerminalSessions],
  );
  const terminalLabelsById = useMemo(() => {
    const summaryByTerminalId = new Map(
      knownTerminalSessions.map((session) => [session.target.terminalId, session.state.summary]),
    );
    return buildOwnerScopedTerminalLabels({
      terminalIds: terminalUiState.terminalIds,
      summaryByTerminalId,
    });
  }, [knownTerminalSessions, terminalUiState.terminalIds]);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const runtimeEnv = useMemo(
    () => (project ? projectScriptRuntimeEnv({ project: { cwd: project.cwd } }) : {}),
    [project],
  );
  const availableEditors = useServerAvailableEditors();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = environmentId === primaryEnvironmentId;
  const { saveProjectScript, updateProjectScript, deleteProjectScript } = useProjectScriptMutations(
    { project, environmentId },
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] =
    useLastInvokedProjectScript();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId,
    threadId: terminalThreadId,
  });

  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !project) return;

      setLastInvokedScriptByProjectId((current) => {
        if (current[project.id] === script.id) return current;
        return { ...current, [project.id]: script.id };
      });

      const baseTerminalId =
        terminalUiState.activeTerminalId ||
        serverOrderedTerminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const shouldCreateNewTerminal = isBaseTerminalBusy;
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(serverOrderedTerminalIds)
        : baseTerminalId;

      if (shouldCreateNewTerminal) {
        storeNewTerminal(terminalThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(terminalThreadRef, targetTerminalId);
      }
      setFocusRequestId((value) => value + 1);

      try {
        await api.terminal.open({
          threadId: terminalThreadId,
          terminalId: targetTerminalId,
          cwd: project.cwd,
          worktreePath: null,
          env: runtimeEnv,
          ...(shouldCreateNewTerminal
            ? { cols: PROJECT_TERMINAL_SCRIPT_COLS, rows: PROJECT_TERMINAL_SCRIPT_ROWS }
            : {}),
        });
        await api.terminal.write({
          threadId: terminalThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch {
        // Failures are surfaced by the terminal itself.
      }
    },
    [
      environmentId,
      project,
      runningTerminalIds,
      runtimeEnv,
      serverOrderedTerminalIds,
      setLastInvokedScriptByProjectId,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalThreadId,
      terminalThreadRef,
      terminalUiState.activeTerminalId,
    ],
  );

  useEffect(() => {
    if (serverOrderedTerminalIds.length === 0) {
      return;
    }
    reconcileTerminalIds(terminalThreadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalThreadRef]);

  const openTerminal = useCallback(
    async (terminalId: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !project) {
        return;
      }
      await api.terminal.open({
        threadId: terminalThreadId,
        terminalId,
        cwd: project.cwd,
        worktreePath: null,
        env: runtimeEnv,
      });
    },
    [environmentId, project, runtimeEnv, terminalThreadId],
  );

  const splitTerminal = useCallback(() => {
    const terminalId = nextTerminalId(terminalUiState.terminalIds);
    storeSplitTerminal(terminalThreadRef, terminalId);
    setFocusRequestId((value) => value + 1);
    void openTerminal(terminalId).catch(() => undefined);
  }, [openTerminal, storeSplitTerminal, terminalThreadRef, terminalUiState.terminalIds]);

  const splitTerminalVertical = useCallback(() => {
    const terminalId = nextTerminalId(terminalUiState.terminalIds);
    storeSplitTerminalVertical(terminalThreadRef, terminalId);
    setFocusRequestId((value) => value + 1);
    void openTerminal(terminalId).catch(() => undefined);
  }, [openTerminal, storeSplitTerminalVertical, terminalThreadRef, terminalUiState.terminalIds]);

  const createNewTerminal = useCallback(() => {
    const terminalId = nextTerminalId(terminalUiState.terminalIds);
    storeNewTerminal(terminalThreadRef, terminalId);
    setFocusRequestId((value) => value + 1);
    void openTerminal(terminalId).catch(() => undefined);
  }, [openTerminal, storeNewTerminal, terminalThreadRef, terminalUiState.terminalIds]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(terminalThreadRef, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [storeSetActiveTerminal, terminalThreadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const isFinalTerminal = terminalUiState.terminalIds.length <= 1;
      void (async () => {
        if (isFinalTerminal) {
          await api.terminal
            .clear({ threadId: terminalThreadId, terminalId })
            .catch(() => undefined);
        }
        await api.terminal.close({
          threadId: terminalThreadId,
          terminalId,
          deleteHistory: true,
        });
      })().catch(() =>
        api.terminal
          .write({ threadId: terminalThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined),
      );
      storeCloseTerminal(terminalThreadRef, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [
      environmentId,
      storeCloseTerminal,
      terminalThreadId,
      terminalThreadRef,
      terminalUiState.terminalIds.length,
    ],
  );

  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <ProjectTerminalHeader title="Project terminal" />
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Project not found</EmptyTitle>
            <EmptyDescription>
              This project is no longer available in this environment.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <ProjectTerminalHeader title={project.name}>
        <ProjectHeaderActions
          gitCwd={project.cwd}
          gitThreadRef={terminalThreadRef}
          scripts={project.scripts}
          keybindings={keybindings}
          availableEditors={availableEditors}
          preferredScriptId={lastInvokedScriptByProjectId[project.id] ?? null}
          showOpenInPicker={showOpenInPicker}
          onRunProjectScript={runProjectScript}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
        />
      </ProjectTerminalHeader>
      <div className="min-h-0 flex-1 [&_.thread-terminal-drawer]:h-full! [&_.thread-terminal-drawer]:border-t-0">
        <ThreadTerminalDrawer
          threadRef={terminalThreadRef}
          threadId={terminalThreadId}
          cwd={project.cwd}
          worktreePath={null}
          runtimeEnv={runtimeEnv}
          visible
          height={PROJECT_TERMINAL_HEIGHT}
          terminalIds={terminalUiState.terminalIds}
          activeTerminalId={terminalUiState.activeTerminalId}
          terminalGroups={terminalUiState.terminalGroups}
          activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
          focusRequestId={focusRequestId}
          onSplitTerminal={splitTerminal}
          onSplitTerminalVertical={splitTerminalVertical}
          onNewTerminal={createNewTerminal}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={() => undefined}
          onAddTerminalContext={() => undefined}
          keybindings={keybindings}
          emptyStateMessage="No project terminal sessions yet."
          terminalLabelsById={terminalLabelsById}
        />
      </div>
    </div>
  );
});

export default ProjectTerminalView;
