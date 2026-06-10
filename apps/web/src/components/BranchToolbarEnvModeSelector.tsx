import { ChevronDownIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import type { EnvironmentId, VcsRef } from "@t3tools/contracts";

import {
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useVcsRefs, vcsRefManager } from "../lib/vcsRefState";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxStatus,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxTrigger,
} from "./ui/combobox";
import { Button } from "./ui/button";

const EMPTY_REFS: ReadonlyArray<VcsRef> = [];

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  projectCwd: string | null;
  environmentId: EnvironmentId;
  onEnvModeChange: (mode: EnvMode) => void;
  onSelectExistingWorktree?: (branch: string, worktreePath: string) => void;
}

type EnvOption = { value: string; label: string; kind: "local" | "local-worktree" | "worktree" };
type WorktreeOption = {
  value: string;
  label: string;
  kind: "worktree-item";
  branch: string;
  path: string;
};

type WorkspaceOption = EnvOption | WorktreeOption;

function workspaceIcon(kind: WorkspaceOption["kind"]) {
  switch (kind) {
    case "worktree":
      return <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />;
    case "local-worktree":
    case "worktree-item":
      return <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  activeThreadBranch,
  projectCwd,
  environmentId,
  onEnvModeChange,
  onSelectExistingWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  // The combobox value is "local" when on a worktree — the trigger label
  // shows the worktree name, but "Local checkout" correctly maps to the
  // same effective mode, so selecting it again is a no-op (user can switch
  // back to the main checkout by selecting "Local checkout" which clears
  // the worktree path).
  const selectValue = effectiveEnvMode === "worktree" ? "worktree" : "local";
  const hasLocalWorktree = activeWorktreePath !== null;
  const cwd = activeWorktreePath ?? projectCwd;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();

  // Fetch all refs to find existing worktrees
  const worktreeRefTarget = useMemo(
    () => ({
      environmentId,
      cwd,
      query: null,
    }),
    [cwd, environmentId],
  );
  const worktreeRefState = useVcsRefs(worktreeRefTarget);
  const allRefs = worktreeRefState.data?.refs ?? EMPTY_REFS;

  const isInitialLoadPending = worktreeRefState.isPending && worktreeRefState.data === null;

  // Build the fixed env options (always visible regardless of search)
  const envOptions: EnvOption[] = useMemo(() => {
    const items: EnvOption[] = [
      { value: "local", label: resolveEnvModeLabel("local"), kind: "local" },
    ];
    if (hasLocalWorktree) {
      items.push({ value: "local-worktree", label: "Current worktree", kind: "local-worktree" });
    }
    items.push({ value: "worktree", label: resolveEnvModeLabel("worktree"), kind: "worktree" });
    return items;
  }, [hasLocalWorktree]);

  // Build existing worktree options from refs (exclude current worktree)
  const allWorktreeOptions: WorktreeOption[] = useMemo(() => {
    return allRefs
      .filter((ref) => ref.worktreePath && ref.worktreePath !== activeWorktreePath)
      .map((ref) => {
        const path = ref.worktreePath!;
        const name = path.split("/").pop() ?? path;
        return {
          value: `worktree:${path}`,
          label: name,
          kind: "worktree-item" as const,
          branch: ref.name,
          path,
        };
      });
  }, [allRefs, activeWorktreePath]);

  // Filter worktree options by query
  const filteredWorktreeOptions = useMemo(() => {
    if (normalizedQuery.length === 0) return allWorktreeOptions;
    return allWorktreeOptions.filter(
      (opt) =>
        opt.branch.toLowerCase().includes(normalizedQuery) ||
        opt.path.toLowerCase().includes(normalizedQuery),
    );
  }, [allWorktreeOptions, normalizedQuery]);

  // Combine: fixed options + separator + filtered worktrees
  const allFilteredOptions = useMemo(() => {
    return [...envOptions, ...filteredWorktreeOptions] as WorkspaceOption[];
  }, [envOptions, filteredWorktreeOptions]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (!open) {
        setQuery("");
        return;
      }
      if (cwd) {
        void vcsRefManager
          .load(worktreeRefTarget, undefined, { limit: 100, preserveLoadedRefs: true })
          .catch(() => undefined);
      }
    },
    [cwd, worktreeRefTarget],
  );

  const handleSelect = useCallback(
    (value: string) => {
      setIsOpen(false);
      setQuery("");

      if (value === "local" || value === "worktree" || value === "local-worktree") {
        onEnvModeChange(value === "worktree" ? "worktree" : "local");
        return;
      }

      // Existing worktree selection
      const worktreeMatch = allWorktreeOptions.find((opt) => opt.value === value);
      if (worktreeMatch && onSelectExistingWorktree) {
        onSelectExistingWorktree(worktreeMatch.branch, worktreeMatch.path);
      }
    },
    [allWorktreeOptions, onEnvModeChange, onSelectExistingWorktree],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  const triggerIcon =
    effectiveEnvMode === "worktree" ? (
      <FolderGit2Icon className="size-3 shrink-0" />
    ) : activeWorktreePath ? (
      <FolderGitIcon className="size-3 shrink-0" />
    ) : (
      <FolderIcon className="size-3 shrink-0" />
    );

  const triggerLabel = useMemo(() => {
    if (effectiveEnvMode === "worktree") return resolveEnvModeLabel("worktree");
    if (activeWorktreePath) {
      return activeWorktreePath.split("/").pop() ?? activeWorktreePath;
    }
    return resolveEnvModeLabel("local");
  }, [activeWorktreePath, effectiveEnvMode]);

  const hasWorktrees = allWorktreeOptions.length > 0;
  const showWorktreeSection = hasWorktrees || isInitialLoadPending;

  return (
    <Combobox
      items={allFilteredOptions}
      filteredItems={allFilteredOptions}
      onOpenChange={handleOpenChange}
      open={isOpen}
      value={selectValue}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        className="gap-1.5 text-muted-foreground/70 hover:text-foreground/80"
      >
        {triggerIcon}
        <span className="max-w-[120px] truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <div className="border-b px-2 py-1.5">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search workspace..."
            showTrigger={false}
            showClear={query.length > 0}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No workspaces found.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {/* Fixed env options — always shown above the search results */}
          {envOptions.map((opt) => (
            <ComboboxItem
              hideIndicator
              key={opt.value}
              value={opt.value}
              onClick={() => handleSelect(opt.value)}
            >
              <div className="flex items-center gap-2 py-0.5">
                {workspaceIcon(opt.kind)}
                <span className="truncate">{opt.label}</span>
              </div>
            </ComboboxItem>
          ))}
          {showWorktreeSection ? (
            <>
              <ComboboxSeparator />
              <ComboboxGroup>
                <ComboboxGroupLabel>Existing worktrees</ComboboxGroupLabel>
                {hasWorktrees ? (
                  filteredWorktreeOptions.map((opt) => (
                    <ComboboxItem
                      hideIndicator
                      key={opt.value}
                      value={opt.value}
                      onClick={() => handleSelect(opt.value)}
                    >
                      <div className="flex items-center gap-2 py-0.5">
                        <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{opt.label}</span>
                      </div>
                    </ComboboxItem>
                  ))
                ) : (
                  <ComboboxStatus>
                    {isInitialLoadPending ? "Loading..." : "No worktrees found."}
                  </ComboboxStatus>
                )}
              </ComboboxGroup>
            </>
          ) : null}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
