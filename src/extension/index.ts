import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessageBus } from "../core/message-bus";
import { StateStore } from "../core/state-store";
import { WorkflowEngine } from "../core/workflow-engine";

const asToolResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export default function (pi: ExtensionAPI): void {
  const root = path.join(process.cwd(), ".orchestra");
  const store = new StateStore(root);
  store.ensure();

  const engine = new WorkflowEngine(pi, process.cwd(), store);
  const bus = new MessageBus(
    path.join(root, "bus.sock"),
    path.join(root, "bus.wal"),
  );

  let initialized = false;

  const initialize = async (): Promise<void> => {
    if (initialized) {
      return;
    }

    await engine.loadWorkflows();
    await bus.start({
      status: () => ({ workflows: engine.list() }),
      workflowStatus: (workflowId: string) =>
        engine.get(workflowId) ?? { error: "unknown_workflow" },
      evidence: async (workflowId: string, body: unknown) =>
        engine.submitEvidence(workflowId, body),
      heartbeat: (agentId: string) => engine.heartbeat(agentId),
    });

    initialized = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    await initialize();
    ctx.ui.setStatus("orchestra", "orchestra: ready");
  });

  pi.on("session_shutdown", async () => {
    await bus.stop();
  });

  pi.registerTool({
    name: "orchestra_start",
    label: "Orchestra Start",
    description: "Start an orchestra workflow",
    parameters: Type.Object({
      workflow: Type.String({ description: "Workflow definition name" }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await initialize();
      const state = engine.start(params.workflow, params.params ?? {});
      const dispatch = await engine.dispatchCurrentState(
        state.workflow_id as unknown as string,
      );
      ctx.ui.notify(
        `Started ${params.workflow} (${state.workflow_id as string})`,
        "info",
      );
      return asToolResult({
        workflowId: state.workflow_id,
        state: state.current_state,
        dispatch,
      });
    },
  });

  pi.registerTool({
    name: "orchestra_status",
    label: "Orchestra Status",
    description: "Get workflow status",
    parameters: Type.Object({
      workflowId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const data = params.workflowId
        ? engine.get(params.workflowId)
        : engine.list();
      return asToolResult(data);
    },
  });

  pi.registerTool({
    name: "orchestra_pause",
    label: "Orchestra Pause",
    description: "Pause a workflow instance",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_toolCallId, params) {
      await initialize();
      return asToolResult(engine.pause(params.workflowId));
    },
  });

  pi.registerTool({
    name: "orchestra_resume",
    label: "Orchestra Resume",
    description: "Resume a workflow instance",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_toolCallId, params) {
      await initialize();
      return asToolResult(engine.resume(params.workflowId));
    },
  });

  pi.registerTool({
    name: "orchestra_override",
    label: "Orchestra Override",
    description: "Force a workflow transition",
    parameters: Type.Object({
      workflowId: Type.String(),
      nextState: Type.String(),
      reason: Type.String(),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      return asToolResult(
        engine.override(params.workflowId, params.nextState, params.reason),
      );
    },
  });

  pi.registerCommand("orchestra", {
    description: "Manage orchestra workflows",
    handler: async (args, ctx) => {
      await initialize();
      await handleCommand(args, ctx, engine);
    },
  });
}

const handleCommand = async (
  args: string,
  ctx: ExtensionCommandContext,
  engine: WorkflowEngine,
): Promise<void> => {
  const [command, ...rest] = args.trim().split(/\s+/);

  if (!command || command === "status") {
    const states = engine.list();
    ctx.ui.notify(`orchestra: ${states.length} workflows`, "info");
    ctx.ui.setWidget(
      "orchestra",
      states.map(
        (state) =>
          `${state.workflow_id}: ${state.current_state} ${state.paused ? "(paused)" : ""}`,
      ),
    );
    return;
  }

  if (command === "pause") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify("usage: /orchestra pause <workflowId>", "error");
      return;
    }
    engine.pause(workflowId);
    ctx.ui.notify(`paused ${workflowId}`, "warning");
    return;
  }

  if (command === "resume") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify("usage: /orchestra resume <workflowId>", "error");
      return;
    }
    engine.resume(workflowId);
    ctx.ui.notify(`resumed ${workflowId}`, "info");
    return;
  }

  ctx.ui.notify(`unknown orchestra command: ${command}`, "error");
};
