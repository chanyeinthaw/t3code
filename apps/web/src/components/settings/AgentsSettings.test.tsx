import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AgentDefinition,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
  ensure: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../agents", () => ({
  readAgents: api.read,
  saveAgent: api.save,
  resetAgent: api.reset,
  removeAgent: api.remove,
}));
vi.mock("../../hub", () => ({ loadHubSession: async () => ({ role: "admin" }) }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { ensureOneChatWorkspace: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => api.ensure }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "machine",
        label: "Machine",
        connection: { phase: "connected" },
        serverConfig: {
          environment: { platform: "linux" },
          settings: {
            defaultModelSelection: { instanceId: "codex", model: "gpt-5" },
            defaultRuntimeMode: "full-access",
          },
          providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
        },
      },
    ],
  }),
}));
// Keep the real settings logic and replace presentation components for the renderer.
function Container({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}
vi.mock("../ui/scroll-area", () => ({ ScrollArea: Container }));
vi.mock("./SettingsGroup", () => ({ SettingsGroup: Container }));
vi.mock("../ui/badge", () => ({ Badge: Container }));
vi.mock("./AgentEnvironmentSelector", () => ({ AgentEnvironmentSelector: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/select", () => ({
  Select: Container,
  SelectItem: Container,
  SelectPopup: Container,
  SelectTrigger: Container,
  SelectValue: () => null,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: Container,
  SettingsSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    description,
    control,
    children,
  }: {
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {description}
      {control}
      {children}
    </div>
  ),
}));

import { AgentsSettings } from "./AgentsSettings";

const machine = EnvironmentId.make("machine");
const pulse: AgentDefinition = {
  id: "pulse",
  name: "Pulse",
  configuration: {
    environmentId: machine,
    threadId: ThreadId.make("agent:pulse:existing"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    additionalInstructions: "Original instructions",
  },
};
const other: AgentDefinition = { ...pulse, id: "other", name: "Other" };
let renderer: ReactTestRenderer;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function render() {
  await act(async () => {
    renderer = create(<AgentsSettings targetEnvironmentId={machine} initialAgentId="pulse" />);
  });
}
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.includes(label))!;
}
function content() {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.read.mockResolvedValue([pulse, other]);
  api.ensure.mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("shows a saved name immediately, preserves the draft on rejection, and restores persisted data", async () => {
  const request = deferred<ReadonlyArray<AgentDefinition>>();
  api.save.mockReturnValue(request.promise);
  await render();
  await act(() => {
    renderer.root.findByProps({ "aria-label": "Agent name" }).props.onChange({
      target: { value: "Renamed" },
    });
  });
  await act(() => {
    button("Save").props.onClick();
  });
  expect(renderer.root.findAllByType("h2").some((node) => node.children.includes("Renamed"))).toBe(
    true,
  );
  expect(content()).not.toContain("Loading");
  await act(async () => {
    request.reject(new Error("Save failed"));
  });
  expect(renderer.root.findAllByType("h2").some((node) => node.children.includes("Pulse"))).toBe(
    true,
  );
  expect(renderer.root.findByProps({ "aria-label": "Agent name" }).props.value).toBe("Renamed");
  expect(content()).toContain("Save failed");
  expect(api.read).toHaveBeenCalledTimes(1);
});

it("selects another agent from the URL without fetching or showing loading again", async () => {
  await render();
  await act(() => {
    renderer.update(<AgentsSettings targetEnvironmentId={machine} initialAgentId="other" />);
  });
  expect(renderer.root.findByProps({ "aria-label": "Agent name" }).props.value).toBe("Other");
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(content()).not.toContain("Loading");
});

it("clears configuration immediately and restores instructions on failure", async () => {
  const request = deferred<ReadonlyArray<AgentDefinition>>();
  api.reset.mockReturnValue(request.promise);
  await render();
  await act(() => {
    button("Clear configuration").props.onClick();
  });
  expect(renderer.root.findByProps({ "aria-label": "Additional instructions" }).props.value).toBe(
    "",
  );
  await act(async () => {
    request.reject(new Error("Rejected"));
  });
  expect(renderer.root.findByProps({ "aria-label": "Additional instructions" }).props.value).toBe(
    "Original instructions",
  );
  expect(content()).toContain("Could not clear agent configuration.");
});

it("removes an agent immediately and restores it and its selection on failure", async () => {
  const request = deferred<ReadonlyArray<AgentDefinition>>();
  api.remove.mockReturnValue(request.promise);
  await render();
  await act(() => {
    renderer.update(<AgentsSettings targetEnvironmentId={machine} initialAgentId="other" />);
  });
  await act(() => {
    button("Remove agent").props.onClick();
  });
  expect(
    renderer.root
      .findAllByType("button")
      .filter((node) => node.props["aria-pressed"] !== undefined),
  ).toHaveLength(1);
  expect(renderer.root.findByProps({ "aria-label": "Agent name" }).props.value).toBe("Pulse");
  await act(async () => {
    request.reject(new Error("Rejected"));
  });
  expect(renderer.root.findByProps({ "aria-label": "Agent name" }).props.value).toBe("Other");
  expect(content()).toContain("Could not remove agent.");
});

it("keeps the saved form mounted when the server confirms and the URL changes", async () => {
  const request = deferred<ReadonlyArray<AgentDefinition>>();
  api.save.mockReturnValue(request.promise);
  await act(async () => {
    renderer = create(<AgentsSettings targetEnvironmentId={machine} />);
  });
  await act(() => {
    button("Save").props.onClick();
  });
  await act(async () => {
    request.resolve([pulse, other]);
  });
  await act(() => {
    renderer.update(<AgentsSettings targetEnvironmentId={machine} initialAgentId="pulse" />);
  });
  expect(renderer.root.findByProps({ "aria-label": "Agent name" }).props.value).toBe("Pulse");
  expect(content()).not.toContain("Loading");
  expect(api.navigate).toHaveBeenCalledWith({
    to: "/settings/agents",
    search: { machine: "machine", agent: "pulse" },
  });
  expect(api.read).toHaveBeenCalledTimes(1);
});
