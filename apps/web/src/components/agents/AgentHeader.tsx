import { AgentAvatar } from "./AgentAvatar";

export function AgentHeader({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
      <AgentAvatar size="small" />
      <span className="min-w-0 truncate text-sm font-medium">{name}</span>
    </div>
  );
}
