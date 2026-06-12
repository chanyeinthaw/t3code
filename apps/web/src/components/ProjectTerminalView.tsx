import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

import { readEnvironmentApi } from "../environmentApi";
import { projectTerminalThreadId } from "../lib/projectTerminal";
import { selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions } from "../terminalSessionState";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

interface ProjectTerminalViewProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  keybindings: ResolvedKeybindingsConfig;
}

const PROJECT_TERMINAL_HEIGHT = 10_000;

const ProjectTerminalHeader = memo(function ProjectTerminalHeader({ title }: { title: string }) {
  return (
    <header
      className={cn(
        "flex h-[52px] shrink-0 items-center border-b border-border px-3 sm:px-5",
        isElectron && "drag-region wco:h-[env(titlebar-area-height)]",
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium text-foreground" title={title}>
          Terminal: {title}
        </h2>
      </div>
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
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
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
    const next = new Map<string, string>();
    for (const session of knownTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [knownTerminalSessions]);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const runtimeEnv = useMemo(
    () => (project ? projectScriptRuntimeEnv({ project: { cwd: project.cwd } }) : {}),
    [project],
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

  useEffect(() => {
    const terminalId = terminalUiState.activeTerminalId || serverOrderedTerminalIds[0] || "term-1";
    storeEnsureTerminal(terminalThreadRef, terminalId, {
      open: true,
      active: true,
    });
    if (project) {
      void openTerminal(terminalId).catch(() => undefined);
    }
  }, [
    openTerminal,
    project,
    serverOrderedTerminalIds,
    storeEnsureTerminal,
    terminalThreadRef,
    terminalUiState.activeTerminalId,
  ]);

  const splitTerminal = useCallback(() => {
    const terminalId = nextTerminalId(terminalUiState.terminalIds);
    storeSplitTerminal(terminalThreadRef, terminalId);
    setFocusRequestId((value) => value + 1);
    void openTerminal(terminalId).catch(() => undefined);
  }, [openTerminal, storeSplitTerminal, terminalThreadRef, terminalUiState.terminalIds]);

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
      <ProjectTerminalHeader title={project.name} />
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
          onNewTerminal={createNewTerminal}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={() => undefined}
          onAddTerminalContext={() => undefined}
          keybindings={keybindings}
          canCloseLastTerminal={false}
          terminalLabelsById={terminalLabelsById}
        />
      </div>
    </div>
  );
});

export default ProjectTerminalView;
