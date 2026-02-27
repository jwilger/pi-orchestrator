import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createJiti } from "jiti";
import { nanoid } from "nanoid";
import type { StateStore } from "./state-store";
import {
  type WorkflowDefinition,
  type WorkflowRuntimeState,
  asAgentId,
  asWorkflowId,
  asWorkflowType,
} from "./types";

export interface EvidenceSubmission {
  state: string;
  result: string;
  evidence: Record<string, unknown>;
  submitted_by?: string;
}

export class WorkflowEngine {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly heartbeats = new Map<string, string>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly cwd: string,
    private readonly store: StateStore,
  ) {}

  async loadWorkflows(): Promise<void> {
    const builtIn = path.join(this.cwd, "src", "workflows");
    await this.loadWorkflowDirectory(builtIn);

    const projectDir = path.join(this.cwd, ".orchestra", "workflows.d");
    await this.loadWorkflowDirectory(projectDir);
  }

  private async loadWorkflowDirectory(directory: string): Promise<void> {
    const fs = await import("node:fs");
    if (!fs.existsSync(directory)) {
      return;
    }

    const jiti = createJiti(import.meta.url);
    for (const entry of fs
      .readdirSync(directory)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
      const modulePath = path.join(directory, entry);
      const loaded = (await jiti.import(modulePath)) as
        | WorkflowDefinition
        | { default?: WorkflowDefinition };
      const workflow = (
        typeof loaded === "object" && loaded && "default" in loaded
          ? (loaded.default ?? loaded)
          : loaded
      ) as WorkflowDefinition;
      this.workflows.set(workflow.name, workflow);
    }
  }

  list(): WorkflowRuntimeState[] {
    return this.store.listWorkflows();
  }

  get(workflowId: string): WorkflowRuntimeState | null {
    return this.store.loadWorkflowState(asWorkflowId(workflowId));
  }

  start(
    workflowType: string,
    params: Record<string, unknown>,
  ): WorkflowRuntimeState {
    const definition = this.workflows.get(workflowType);
    if (!definition) {
      throw new Error(`Unknown workflow: ${workflowType}`);
    }

    const workflowId = asWorkflowId(`${workflowType}-${nanoid(8)}`);
    const firstState =
      definition.initialState ?? Object.keys(definition.states)[0];
    if (!firstState) {
      throw new Error(`Workflow ${workflowType} has no states`);
    }

    const now = new Date().toISOString();
    const state: WorkflowRuntimeState = {
      workflow_id: workflowId,
      workflow_type: asWorkflowType(workflowType),
      current_state: firstState,
      retry_count: 0,
      paused: false,
      params,
      evidence: {},
      metrics: {},
      history: [{ state: firstState, entered_at: now, retries: 0 }],
      created_at: now,
      updated_at: now,
    };

    this.store.saveWorkflowState(state);
    return state;
  }

  async submitEvidence(
    workflowId: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    const state = this.get(workflowId);
    if (!state) {
      throw new Error(`Unknown workflow instance: ${workflowId}`);
    }

    if (state.paused) {
      return { workflowId, status: "paused" };
    }

    const submission = payload as EvidenceSubmission;
    if (!submission.state || submission.state !== state.current_state) {
      return {
        workflowId,
        status: "rejected",
        reason: `Evidence state mismatch. Expected ${state.current_state}`,
      };
    }

    const definition = this.workflows.get(
      state.workflow_type as unknown as string,
    );
    if (!definition) {
      throw new Error(`Workflow definition missing: ${state.workflow_type}`);
    }

    const currentDefinition = definition.states[state.current_state];
    if (!currentDefinition || !("gate" in currentDefinition)) {
      return {
        workflowId,
        status: "rejected",
        reason: "Current state does not accept evidence",
      };
    }

    let verified = true;
    if (
      currentDefinition.gate.kind === "evidence" &&
      currentDefinition.gate.verify
    ) {
      const verify = currentDefinition.gate.verify;
      const result = await this.execCommand(verify.command);
      verified = result.code === (verify.expectExitCode ?? 0);
    }

    if (currentDefinition.gate.kind === "command") {
      const verify = currentDefinition.gate.verify;
      const result = await this.execCommand(verify.command);
      verified = result.code === (verify.expectExitCode ?? 0);
    }

    if (currentDefinition.gate.kind === "verdict") {
      verified = currentDefinition.gate.options.includes(submission.result);
    }

    const historyEntry = state.history.at(-1);

    if (!verified) {
      state.retry_count += 1;
      if (historyEntry) {
        historyEntry.retries = state.retry_count;
        historyEntry.last_failure = `Gate verification failed for ${state.current_state}`;
      }

      const retryLimit =
        "maxRetries" in currentDefinition
          ? (currentDefinition.maxRetries ?? 1)
          : 1;
      if (state.retry_count >= retryLimit) {
        const escalate = currentDefinition.transitions.fail ?? "ESCALATE";
        this.moveState(state, escalate, "fail");
      }

      state.updated_at = new Date().toISOString();
      state.evidence[state.current_state] = {
        ...submission.evidence,
        verified: false,
      };
      this.store.saveWorkflowState(state);
      return {
        workflowId,
        status: "failed",
        state: state.current_state,
        retries: state.retry_count,
      };
    }

    state.evidence[state.current_state] = {
      ...submission.evidence,
      result: submission.result,
      verified: true,
      submitted_by: submission.submitted_by,
      submitted_at: new Date().toISOString(),
    };

    const transitionKey =
      submission.result in currentDefinition.transitions
        ? submission.result
        : "pass";
    const next =
      currentDefinition.transitions[transitionKey] ??
      currentDefinition.transitions.pass;
    if (!next) {
      throw new Error(`No transition for state ${state.current_state}`);
    }

    state.retry_count = 0;
    this.moveState(state, next, transitionKey);
    this.store.saveWorkflowState(state);

    return {
      workflowId,
      status: "advanced",
      from: submission.state,
      to: state.current_state,
      result: submission.result,
    };
  }

  pause(workflowId: string): WorkflowRuntimeState {
    const state = this.requireWorkflow(workflowId);
    state.paused = true;
    state.updated_at = new Date().toISOString();
    this.store.saveWorkflowState(state);
    return state;
  }

  resume(workflowId: string): WorkflowRuntimeState {
    const state = this.requireWorkflow(workflowId);
    state.paused = false;
    state.updated_at = new Date().toISOString();
    this.store.saveWorkflowState(state);
    return state;
  }

  override(
    workflowId: string,
    nextState: string,
    reason: string,
  ): WorkflowRuntimeState {
    const state = this.requireWorkflow(workflowId);
    this.moveState(state, nextState, `override:${reason}`);
    this.store.saveWorkflowState(state);
    return state;
  }

  heartbeat(agentId: string): { ok: true; agentId: string; at: string } {
    const at = new Date().toISOString();
    this.heartbeats.set(agentId, at);
    return { ok: true, agentId, at };
  }

  async dispatchCurrentState(
    workflowId: string,
  ): Promise<{ dispatched: boolean; details: string }> {
    const state = this.requireWorkflow(workflowId);
    const definition = this.workflows.get(
      state.workflow_type as unknown as string,
    );
    if (!definition) {
      throw new Error(`Unknown workflow definition for ${state.workflow_type}`);
    }

    const current = definition.states[state.current_state];
    if (!current) {
      throw new Error(`Unknown state ${state.current_state}`);
    }

    if ("type" in current && current.type === "terminal") {
      return {
        dispatched: false,
        details: `Workflow is terminal: ${current.result}`,
      };
    }

    if ("type" in current && current.type === "action") {
      for (const cmd of current.commands) {
        await this.execCommand(cmd);
      }
      return { dispatched: false, details: "Action state commands executed" };
    }

    const role = definition.roles[current.assign];
    if (!role) {
      throw new Error(`Role ${current.assign} not defined`);
    }

    const agentId = asAgentId(`${workflowId}-${current.assign}`);
    await this.spawnAgent({
      agentId: agentId as unknown as string,
      workflowId,
      role: current.assign,
      roleDefinition: role,
      state: state.current_state,
    });

    return {
      dispatched: true,
      details: `Dispatched ${agentId as unknown as string} for ${state.current_state}`,
    };
  }

  private async spawnAgent(input: {
    agentId: string;
    workflowId: string;
    role: string;
    roleDefinition: WorkflowDefinition["roles"][string];
    state: string;
  }): Promise<void> {
    const runtimeDir = path.join(
      this.cwd,
      ".orchestra",
      "runtime",
      input.agentId,
    );
    const fs = await import("node:fs");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const scopePath = path.join(runtimeDir, "scope.ts");
    const promptPath = path.join(runtimeDir, "prompt.md");
    const taskPath = path.join(runtimeDir, "initial-task.md");

    fs.writeFileSync(
      scopePath,
      buildScopeExtension({
        agentId: input.agentId,
        workflowId: input.workflowId,
        writable: input.roleDefinition.fileScope.writable,
      }),
      "utf8",
    );

    fs.writeFileSync(
      promptPath,
      `# Role ${input.role}\n\nWorkflow: ${input.workflowId}\nState: ${input.state}\n\nFollow tool scope strictly.`,
      "utf8",
    );

    fs.writeFileSync(
      taskPath,
      `Execute state ${input.state} for workflow ${input.workflowId}. Submit evidence when done.`,
      "utf8",
    );

    await this.execCommand(
      `zellij action new-pane --name ${shellEscape(input.agentId)} --cwd ${shellEscape(this.cwd)} --close-on-exit -- pi --mode json -p --no-session --tools ${shellEscape(input.roleDefinition.tools.join(","))} -e ${shellEscape(scopePath)} --append-system-prompt ${shellEscape(promptPath)} \"$(cat ${shellEscape(taskPath)})\"`,
    );
  }

  private moveState(
    state: WorkflowRuntimeState,
    nextState: string,
    result: string,
  ): void {
    const now = new Date().toISOString();
    const currentHistory = state.history.at(-1);
    if (currentHistory) {
      currentHistory.exited_at = now;
      currentHistory.result = result;
    }

    state.current_state = nextState;
    state.updated_at = now;
    state.history.push({ state: nextState, entered_at: now, retries: 0 });
  }

  private requireWorkflow(workflowId: string): WorkflowRuntimeState {
    const state = this.get(workflowId);
    if (!state) {
      throw new Error(`Unknown workflow instance: ${workflowId}`);
    }
    return state;
  }

  private async execCommand(
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const exec = (this.pi as unknown as { exec?: ExtensionAPI["exec"] }).exec;
    if (!exec) {
      return { code: 127, stdout: "", stderr: "exec unavailable" };
    }

    const result = await exec("bash", ["-lc", command], {});
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

const shellEscape = (value: string): string => value.replace(/'/g, "'\\''");

const buildScopeExtension = (input: {
  agentId: string;
  workflowId: string;
  writable: string[];
}): string => `
import { Type } from "@sinclair/typebox";
import { minimatch } from "minimatch";
import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import http from "node:http";

const AGENT_ID = ${JSON.stringify(input.agentId)};
const WORKFLOW_ID = ${JSON.stringify(input.workflowId)};
const WRITABLE = ${JSON.stringify(input.writable)};
const SOCKET_PATH = ".orchestra/bus.sock";

const matches = (target) => WRITABLE.some((glob) => minimatch(target, glob, { dot: true }));

const busRequest = (method, path, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET_PATH, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data ? JSON.parse(data) : {}));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      if (!matches(event.input.path)) {
        return { block: true, reason: \`[BLOCKED] agent \${AGENT_ID} cannot write \${event.input.path}\` };
      }
    }
  });

  pi.registerTool({
    name: "send_message",
    description: "Send a message to another orchestra agent",
    parameters: Type.Object({
      to: Type.String(),
      type: Type.String(),
      payload: Type.Any(),
    }),
    async execute(_id, params) {
      await busRequest("POST", "/messages", {
        from: AGENT_ID,
        to: params.to,
        type: params.type,
        payload: params.payload,
        workflow_id: WORKFLOW_ID,
      });
      return { content: [{ type: "text", text: \`message sent to \${params.to}\` }] };
    },
  });

  pi.registerTool({
    name: "check_inbox",
    description: "Get any pending messages for this agent",
    parameters: Type.Object({}),
    async execute() {
      const messages = await busRequest("GET", \`/inbox/\${AGENT_ID}\`);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "submit_evidence",
    description: "Submit workflow gate evidence",
    parameters: Type.Object({
      state: Type.String(),
      result: Type.String(),
      evidence: Type.Record(Type.String(), Type.Any()),
    }),
    async execute(_id, params) {
      const result = await busRequest("POST", \`/evidence/\${WORKFLOW_ID}\`, {
        state: params.state,
        result: params.result,
        evidence: params.evidence,
        submitted_by: AGENT_ID,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  });
}
`;
