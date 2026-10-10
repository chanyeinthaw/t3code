import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  Clock3Icon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { AGENT_COMPLETION_DISPLAY_MS, hasRecentAgentCompletion } from "./agentActivity";

const statuses = {
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info" },
  waiting: { label: "Waiting", Icon: Clock3Icon, className: "text-muted-foreground" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  limited: { label: "Limited", Icon: CircleAlertIcon, className: "text-warning" },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error" },
  done: { label: "Done", Icon: CircleCheckIcon, className: "text-success" },
};

function AgentStatusLabel({
  status,
  goalActive = false,
}: {
  status: keyof typeof statuses;
  goalActive?: boolean;
}) {
  const { label, Icon, className } = statuses[status];
  const description = status === "working" && goalActive ? "Goal" : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={`flex rounded-full bg-sidebar p-0.5 ${className}`} />}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only" role="status">
          {description}
        </span>
      </TooltipTrigger>
      <TooltipPopup>{description}</TooltipPopup>
    </Tooltip>
  );
}

function RecentCompletionStatus({ completedAt }: { completedAt: string }) {
  const [visible, setVisible] = useState(() =>
    hasRecentAgentCompletion({ status: "completed", completedAt }, Date.now()),
  );
  useEffect(() => {
    if (!visible) return;
    const remaining = Date.parse(completedAt) + AGENT_COMPLETION_DISPLAY_MS - Date.now();
    const timer = window.setTimeout(() => setVisible(false), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [completedAt, visible]);
  return visible ? <AgentStatusLabel status="done" /> : null;
}

export function AgentActivityStatus({ thread }: { thread: EnvironmentThreadShell | null }) {
  if (!thread) return null;
  const status = resolveSidebarThreadStatus(thread);
  if (status !== "ready")
    return <AgentStatusLabel status={status} goalActive={thread.goal?.status === "active"} />;
  const run = thread.latestRun;
  return run?.status === "completed" && run.completedAt ? (
    <RecentCompletionStatus key={run.completedAt} completedAt={run.completedAt} />
  ) : null;
}
