import { ChevronDownIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { useWorkspaceMode, workspaceDestination } from "./workspaceMode";

export function WorkspaceModePicker({ onBackdrop }: { onBackdrop: boolean }) {
  const mode = useWorkspaceMode();
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger
        aria-label="Workspace"
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-sm font-medium tracking-tight outline-hidden focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]",
              onBackdrop
                ? "text-white/85 hover:bg-white/12"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          />
        }
      >
        <span className="[text-box:trim-both_cap_alphabetic]">
          {mode === "agents" ? "Agents" : "Code"}
        </span>
        <ChevronDownIcon aria-hidden className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (value === "code" || value === "agents")
              void navigate({ href: workspaceDestination(value) });
          }}
        >
          <MenuRadioItem value="code">
            <span className="flex items-center gap-2">
              <span className="flex-1">Code</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="agents">
            <span className="flex items-center gap-2">
              <span className="flex-1">Agents</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
