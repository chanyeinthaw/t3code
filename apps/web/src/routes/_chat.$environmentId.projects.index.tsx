import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { ActivityIcon, ArchiveIcon, FolderPlusIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { ProjectShell, ProjectShellPage } from "../components/ProjectShell";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { buildProjectThreadsRouteParams } from "../projectTabs";
import { selectEnvironmentState, selectProjectsForEnvironment, useStore } from "../store";
import { normalizeSearchText } from "../components/CommandPalette.logic";
import { cn } from "../lib/utils";

function EnvironmentProjectsIndexRouteView() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  const environmentState = useStore((state) => selectEnvironmentState(state, environmentId));
  const normalizedQuery = normalizeSearchText(query);
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return projects;
    return projects.filter((project) =>
      normalizeSearchText(`${project.name} ${project.cwd}`).includes(normalizedQuery),
    );
  }, [normalizedQuery, projects]);

  return (
    <ProjectShell
      context={{
        environmentId,
        projectId: null,
        activeThreadId: null,
        activeView: "projects",
      }}
    >
      <ProjectShellPage>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/60 pb-4">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Workspace
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Projects</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose a physical project in this environment.
              </p>
            </div>
            <Button onClick={() => useCommandPaletteStore.getState().openAddProject()}>
              <FolderPlusIcon className="size-4" />
              Add project
            </Button>
          </div>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-foreground/45" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects…"
              className="[&_[data-slot=input]]:pl-9"
            />
          </div>
          <div className="grid gap-2">
            {filteredProjects.map((project) => {
              const threadIds = environmentState.threadIdsByProjectId[project.id] ?? [];
              const projectThreads = threadIds.flatMap((threadId) => {
                const thread = environmentState.sidebarThreadSummaryById[threadId];
                return thread ? [thread] : [];
              });
              const activeThreadCount = projectThreads.filter(
                (thread) => thread.archivedAt === null,
              ).length;
              const archivedThreadCount = projectThreads.length - activeThreadCount;
              const runningThreadCount = projectThreads.filter(
                (thread) =>
                  thread.session?.status === "running" || thread.latestTurn?.state === "running",
              ).length;
              const pendingThreadCount = projectThreads.filter(
                (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
              ).length;
              const ref = scopeProjectRef(project.environmentId, project.id);
              return (
                <button
                  key={project.id}
                  type="button"
                  className={cn(
                    "group flex min-w-0 items-center gap-4 rounded-2xl border border-border/70 bg-card/35 p-4 text-left transition-all hover:-translate-y-px hover:border-border hover:bg-accent/35 hover:shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/projects/$projectId/threads",
                      params: buildProjectThreadsRouteParams(ref),
                    })
                  }
                >
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl  transition-colors group-hover:bg-background">
                    <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {project.name}
                      </div>
                      {project.repositoryIdentity ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          <GitBranchIcon className="size-3" /> repo
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
                      {project.cwd}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5">
                        {activeThreadCount} active
                      </span>
                      {runningThreadCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          <ActivityIcon className="size-3" /> {runningThreadCount} running
                        </span>
                      ) : null}
                      {pendingThreadCount > 0 ? (
                        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                          {pendingThreadCount} pending
                        </span>
                      ) : null}
                      {archivedThreadCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2 py-0.5">
                          <ArchiveIcon className="size-3" /> {archivedThreadCount} archived
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}
            {filteredProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                No projects found.
              </div>
            ) : null}
          </div>
        </div>
      </ProjectShellPage>
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/projects/")({
  component: EnvironmentProjectsIndexRouteView,
});
