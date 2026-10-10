import { renderWorkspaceBrand } from "./WorkspaceBrand";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { orderAgents } from "./agentOrder";

import { AgentSidebarItem } from "./AgentSidebarItem";
import { type AgentDefinition } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readAgents } from "../../agents";
import { isElectron } from "../../env";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup, SidebarMenu, useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";

const agentOrderSchema = Schema.Array(Schema.String);
const emptyOrder: ReadonlyArray<string> = [];

/** Lists hub agents across every environment, independently of project grouping. */
export function AgentsSidebar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const [agents, setAgents] = useState<ReadonlyArray<AgentDefinition>>([]);
  const [savedOrder, setSavedOrder] = useLocalStorage(
    "pulse.agent-sidebar-order",
    emptyOrder,
    agentOrderSchema,
  );
  const orderedAgents = orderAgents(agents, savedOrder);
  const ids = orderedAgents.map((agent) => agent.id);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setSavedOrder(arrayMove(ids, from, to));
  }
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void readAgents(controller.signal)
        .then((entries) => {
          if (!controller.signal.aborted) {
            setAgents(entries);
            setError(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      window.removeEventListener("focus", load);
    };
  }, [pathname, retry]);
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} renderBrand={renderWorkspaceBrand} />
      <SidebarContent>
        <SidebarGroup>
          <div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                <SidebarMenu>
                  {orderedAgents.map((agent) => (
                    <AgentSidebarItem
                      key={agent.id}
                      agent={agent}
                      isActive={pathname === `/agents/${encodeURIComponent(agent.id)}`}
                      onSelect={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    />
                  ))}
                </SidebarMenu>
              </SortableContext>
            </DndContext>
            {error ? (
              <div className="space-y-2 p-2 text-sm text-muted-foreground">
                <p>Could not load agents.</p>
                <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
