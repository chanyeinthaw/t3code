import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";

export function NoActiveThreadState() {
  const { open } = useSidebar();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? cn(
                  "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]",
                  !open &&
                    "pl-[90px] wco:pl-[calc(env(titlebar-area-x)+1em)] sm:pl-[90px] sm:wco:pl-[calc(env(titlebar-area-x)+1em)]",
                )
              : "flex h-[52px] shrink-0 items-center",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {!open && (
              <SidebarTrigger className="hidden shrink-0 md:inline-flex" />
            )}
            <SidebarTrigger className="shrink-0 md:hidden" />
            <span className="truncate text-sm font-medium text-foreground md:text-muted-foreground/60">
              No active thread
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">
                Pick a thread to continue
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
