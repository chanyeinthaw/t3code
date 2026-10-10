import { BotIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export function AgentAvatar({ size = "default" }: { size?: "default" | "small" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground",
        size === "small" ? "size-6" : "size-8",
      )}
    >
      <BotIcon className={size === "small" ? "size-4" : "size-5"} />
    </span>
  );
}
