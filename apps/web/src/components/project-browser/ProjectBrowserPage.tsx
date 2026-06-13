import { type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface ProjectBrowserPageProps {
  header: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ProjectBrowserPage({ header, children, className }: ProjectBrowserPageProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="shrink-0 border-b border-border/80 px-4 py-2.5 sm:px-6">{header}</div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export interface ProjectBrowserHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
  className?: string;
}

export function ProjectBrowserHeader({
  title,
  subtitle,
  actions,
  search,
  className,
}: ProjectBrowserHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4", className)}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold tracking-tight text-foreground">
          {title}
        </div>
        {subtitle ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {search ? <div className="w-full max-w-[240px] sm:max-w-xs">{search}</div> : null}
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export interface ProjectBrowserEmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function ProjectBrowserEmptyState({
  title,
  description,
  action,
  className,
}: ProjectBrowserEmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center", className)}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
