import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { T3Wordmark } from "../T3Wordmark";
import { WorkspaceModePicker } from "./WorkspaceModePicker";

export function WorkspaceBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <div className="relative z-10 ml-[var(--workspace-titlebar-content-left)] flex h-7 w-fit min-w-0 shrink-0 items-baseline gap-1">
      <Link
        aria-label="Go to threads"
        className={cn(
          "rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
          onBackdrop ? "text-white" : "text-foreground",
        )}
        to="/"
      >
        <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      </Link>
      <WorkspaceModePicker onBackdrop={onBackdrop} />
    </div>
  );
}

// Measure the wider mode so switching workspaces never clips the picker.
export function WorkspaceBrandMark() {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      <span className="inline-flex h-7 items-center gap-1 px-1 text-muted-foreground">
        <span className="[text-box:trim-both_cap_alphabetic]">Agents</span>
        <ChevronDownIcon className="size-3" />
      </span>
    </span>
  );
}

export function renderWorkspaceBrand(onBackdrop: boolean) {
  return <WorkspaceBrand onBackdrop={onBackdrop} />;
}
