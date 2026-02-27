import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createJiti } from "jiti";
import { nanoid } from "nanoid";
import { validateEvidenceForState } from "../evidence/schema-registry";
import type { ProjectConfig, RoleOverride } from "../project/config";
import type { StateStore } from "./state-store";
import {
  type AgentState,
  type GateDefinition,
  type SubworkflowState,
  type WorkflowDefinition,
  type WorkflowRuntimeState,
  type WorkflowStateHistory,
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
  private projectConfig: ProjectConfig | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly cwd: string,
    private readonly store: StateStore,
    projectConfig?: ProjectConfig,
  ) {
    this.projectConfig = projectConfig;
  }

  setProjectConfig(config: ProjectConfig): void {
    this.projectConfig = config;
  }

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
    for (const entry of fs.readdirSync(directory).filter((f) => {
      const ext = path.extname(f);
      return ext === ".ts" || ext === ".js";
    })) {
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

  listDefinitions(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  getDefinition(workflowType: string): WorkflowDefinition | undefined {
    return this.workflows.get(workflowType);
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
    if (currentDefinition.gate.kind === "evidence") {
      const validation = validateEvidenceForState(
        state.current_state,
        currentDefinition.gate.schema,
        submission.evidence,
      );
      if (!validation.ok) {
        state.evidence[state.current_state] = {
          ...submission.evidence,
          verified: false,
          validation_errors: validation.errors,
        };
        state.updated_at = new Date().toISOString();
        this.store.saveWorkflowState(state);
        return {
          workflowId,
          status: "rejected",
          reason: "Evidence schema validation failed",
          diagnostics: validation,
        };
      }

      const verify = currentDefinition.gate.verify;
      if (verify) {
        const result = await this.execCommand(verify.command);
        const expectedExitCode = verify.expectExitCode ?? 0;
        verified = result.code === expectedExitCode;
      }
    }

    if (currentDefinition.gate.kind === "command") {
      const verify = currentDefinition.gate.verify;
      const result = await this.execCommand(verify.command);
      const expectedExitCode = verify.expectExitCode ?? 0;
      verified = result.code === expectedExitCode;
    }

    if (currentDefinition.gate.kind === "verdict") {
      verified = currentDefinition.gate.options.includes(submission.result);
    }

    const historyEntry = state.history.at(-1);
    if (!historyEntry) {
      throw new Error(`Workflow history missing for ${workflowId}`);
    }

    if (!verified) {
      state.retry_count += 1;
      historyEntry.retries = state.retry_count;
      historyEntry.last_failure = `Gate verification failed for ${state.current_state}`;

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

    const hasDirectTransition = Object.hasOwn(
      currentDefinition.transitions,
      submission.result,
    );
    const next = hasDirectTransition
      ? currentDefinition.transitions[submission.result]
      : currentDefinition.transitions.pass;
    if (!next) {
      throw new Error(`No transition for state ${state.current_state}`);
    }

    state.retry_count = 0;
    this.moveState(state, next, submission.result);
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

    // AgentState is the only variant without `type`
    if ("assign" in current) {
      return this.dispatchAgentState(workflowId, state, current, definition);
    }

    if (current.type === "terminal") {
      // If this workflow has a parent, propagate completion
      if (state.parent) {
        await this.completeChildWorkflow(state);
      }
      return {
        dispatched: false,
        details: `Workflow is terminal: ${current.result}`,
      };
    }

    if (current.type === "action") {
      for (const cmd of current.commands) {
        await this.execCommand(cmd);
      }
      return { dispatched: false, details: "Action state commands executed" };
    }

    if (current.type === "subworkflow") {
      return this.dispatchSubworkflow(workflowId, state, current, definition);
    }

    throw new Error(`State ${state.current_state} has unrecognized type`);
  }

  private async dispatchAgentState(
    workflowId: string,
    state: WorkflowRuntimeState,
    current: AgentState,
    definition: WorkflowDefinition,
  ): Promise<{ dispatched: boolean; details: string }> {
    const baseRole = definition.roles[current.assign];
    if (!baseRole) {
      throw new Error(`Role ${current.assign} not defined`);
    }

    const configuredRole = applyRoleOverrides(
      baseRole,
      current.assign,
      this.projectConfig,
    );
    const paramBoundRole = resolvePersonaFromParams(
      configuredRole,
      state.params,
    );
    const effectiveRole = resolvePersonaForDispatch(
      paramBoundRole,
      current.assign,
      state,
      definition,
    );

    const agentId = asAgentId(`${workflowId}-${current.assign}`);
    await this.spawnAgent({
      agentId: agentId as unknown as string,
      workflowId,
      role: current.assign,
      roleDefinition: effectiveRole,
      state: state.current_state,
      workflowDefinition: definition,
      runtimeState: state,
      stateDefinition: current,
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
    workflowDefinition: WorkflowDefinition;
    runtimeState: WorkflowRuntimeState;
    stateDefinition: AgentState;
  }): Promise<void> {
    const runtimeDir = path.join(
      this.cwd,
      ".orchestra",
      "runtime",
      input.agentId,
    );
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
    );

    fs.writeFileSync(
      promptPath,
      buildAgentPrompt({
        role: input.role,
        roleDefinition: input.roleDefinition,
        workflowId: input.workflowId,
        workflowDefinition: input.workflowDefinition,
        state: input.state,
        stateDefinition: input.stateDefinition,
        projectConfig: this.projectConfig,
        cwd: this.cwd,
      }),
    );

    fs.writeFileSync(
      taskPath,
      buildAgentTask({
        workflowId: input.workflowId,
        state: input.state,
        stateDefinition: input.stateDefinition,
        runtimeState: input.runtimeState,
        projectConfig: this.projectConfig,
      }),
    );

    const sessionDir = path.join(runtimeDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    await this.execCommand(
      `zellij action new-tab --name ${shellEscape(input.agentId)} --cwd ${shellEscape(this.cwd)} -- pi --tools ${shellEscape(input.roleDefinition.tools.join(","))} -e ${shellEscape(scopePath)} --append-system-prompt ${shellEscape(promptPath)} --session-dir ${shellEscape(sessionDir)} @${shellEscape(taskPath)}`,
    );
  }

  private async dispatchSubworkflow(
    parentWorkflowId: string,
    parentState: WorkflowRuntimeState,
    subDef: SubworkflowState,
    parentDefinition: WorkflowDefinition,
  ): Promise<{ dispatched: boolean; details: string }> {
    // Resolve the child workflow name — literal or $slot reference
    const childWorkflowType = resolveWorkflowSlot(
      subDef.workflow,
      parentState.params,
    );

    const childDefinition = this.workflows.get(childWorkflowType);
    if (!childDefinition) {
      throw new Error(
        `Subworkflow "${childWorkflowType}" not found (resolved from "${subDef.workflow}")`,
      );
    }

    // Build child params from inputMap
    const childParams = resolveInputMap(subDef.inputMap ?? {}, parentState);

    // Start the child workflow
    const childState = this.start(childWorkflowType, childParams);

    // Record the parent → child link
    childState.parent = {
      workflow_id: parentState.workflow_id,
      state: parentState.current_state,
    };
    this.store.saveWorkflowState(childState);

    // Record child on parent
    if (!parentState.children) {
      parentState.children = {};
    }
    parentState.children[parentState.current_state] = childState.workflow_id;
    parentState.updated_at = new Date().toISOString();
    this.store.saveWorkflowState(parentState);

    // Dispatch the child's first state
    const childDispatch = await this.dispatchCurrentState(
      childState.workflow_id as unknown as string,
    );

    return {
      dispatched: true,
      details: `Subworkflow ${childState.workflow_id} (${childWorkflowType}) started for ${parentState.current_state}. Child dispatch: ${childDispatch.details}`,
    };
  }

  private async completeChildWorkflow(
    childState: WorkflowRuntimeState,
  ): Promise<void> {
    if (!childState.parent) {
      return;
    }

    const parentState = this.get(
      childState.parent.workflow_id as unknown as string,
    );
    if (!parentState) {
      return;
    }

    const parentDefinition = this.workflows.get(
      parentState.workflow_type as unknown as string,
    );
    if (!parentDefinition) {
      return;
    }

    const parentStateDef = parentDefinition.states[childState.parent.state];
    if (
      !parentStateDef ||
      !("type" in parentStateDef) ||
      parentStateDef.type !== "subworkflow"
    ) {
      return;
    }

    // Determine child terminal result
    const childDef = this.workflows.get(
      childState.workflow_type as unknown as string,
    );
    const childCurrentDef = childDef?.states[childState.current_state];
    const childResult =
      childCurrentDef && "result" in childCurrentDef
        ? childCurrentDef.result
        : "failure";

    // Merge child evidence into parent under the state name
    parentState.evidence[childState.parent.state] = {
      child_workflow_id: childState.workflow_id,
      child_workflow_type: childState.workflow_type,
      child_result: childResult,
      child_evidence: childState.evidence,
    };

    // Transition parent based on child result
    const transition =
      parentStateDef.transitions[childResult] ??
      parentStateDef.transitions.pass;
    if (transition) {
      parentState.retry_count = 0;
      this.moveState(parentState, transition, childResult);
      this.store.saveWorkflowState(parentState);

      // Auto-dispatch the parent's next state
      await this.dispatchCurrentState(
        parentState.workflow_id as unknown as string,
      );
    } else {
      this.store.saveWorkflowState(parentState);
    }
  }

  private moveState(
    state: WorkflowRuntimeState,
    nextState: string,
    result: string,
  ): void {
    const now = new Date().toISOString();
    const currentHistory = state.history.at(-1);
    if (!currentHistory) {
      throw new Error(`Workflow history missing for ${state.workflow_id}`);
    }

    currentHistory.exited_at = now;
    currentHistory.result = result;

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

export const shellEscape = (value: string): string =>
  value.replace(/'/g, "'\\''");

// --- Agent definition resolution ---

const builtinAgentsDir = (): string => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return path.join(path.dirname(thisFile), "..", "agents");
  } catch {
    return path.join(process.cwd(), "src", "agents");
  }
};

export const resolveAgentDefinition = (
  agentName: string,
  cwd: string,
): string | null => {
  // Check project override first
  const overridePath = path.join(
    cwd,
    ".orchestra",
    "agents.d",
    `${agentName}.md`,
  );
  if (fs.existsSync(overridePath)) {
    try {
      return fs.readFileSync(overridePath, "utf8");
    } catch {
      // fall through
    }
  }

  // Fall back to built-in
  const builtinPath = path.join(builtinAgentsDir(), `${agentName}.md`);
  if (fs.existsSync(builtinPath)) {
    try {
      return fs.readFileSync(builtinPath, "utf8");
    } catch {
      return null;
    }
  }

  return null;
};

const readPersona = (personaPath: string, cwd: string): string | null => {
  const resolved = path.isAbsolute(personaPath)
    ? personaPath
    : path.join(cwd, personaPath);
  if (fs.existsSync(resolved)) {
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }
  return null;
};

const formatGateSchema = (gate: GateDefinition): string => {
  if (gate.kind === "evidence") {
    const fields = Object.entries(gate.schema)
      .map(([key, type]) => `  - ${key}: ${type}`)
      .join("\n");
    return `Gate kind: evidence\nRequired fields:\n${fields}`;
  }
  if (gate.kind === "verdict") {
    return `Gate kind: verdict\nAllowed options: ${gate.options.join(", ")}`;
  }
  return `Gate kind: command\nVerification command: ${gate.verify.command}`;
};

const buildStateInstructions = (
  stateName: string,
  gate: GateDefinition,
  projectConfig?: ProjectConfig,
): string => {
  const testRunner = projectConfig?.testRunner ?? "npm test";

  // Provide state-specific guidance based on common state name patterns and gate kind
  const upper = stateName.toUpperCase();

  if (upper === "RED" || upper.startsWith("RED_")) {
    return `You are in the RED phase of TDD. Write a failing test for the next acceptance criterion. Run \`${testRunner}\` to verify it fails. Submit evidence with the test file path and failure output.`;
  }
  if (upper === "GREEN" || upper.startsWith("GREEN_")) {
    return `You are in the GREEN phase of TDD. Implement the minimal production code to make the failing test pass. Run \`${testRunner}\` to verify all tests pass. Submit evidence with implementation file paths and passing test output.`;
  }
  if (upper === "REFACTOR" || upper.startsWith("REFACTOR_")) {
    return `You are in the REFACTOR phase. Improve code structure without changing behavior. Run \`${testRunner}\` to verify all tests still pass. Submit evidence with refactored file paths.`;
  }
  if (upper.includes("TDD_CYCLE") || upper.includes("PIPELINE")) {
    return `You are the pipeline agent coordinating TDD cycles. Review the acceptance criteria and determine which are not yet satisfied. For each unmet criterion, dispatch work by submitting a verdict of 'retry' to continue or 'complete' when all criteria are met.`;
  }
  if (upper.includes("REVIEW") || upper.includes("DOMAIN_REVIEW")) {
    if (gate.kind === "verdict") {
      return `Review the code changes carefully. Submit a verdict of '${gate.options.join("' or '")}' with rationale explaining your assessment.`;
    }
    return "Review the code changes and submit your assessment.";
  }
  if (upper === "SETUP") {
    return "Set up the workspace for this workflow. Gather requirements, identify the branch and slice, and submit the initial evidence to proceed.";
  }

  // Generic fallback based on gate kind
  if (gate.kind === "evidence") {
    return `Complete the work for state ${stateName}. Gather the required evidence fields and submit them.`;
  }
  if (gate.kind === "verdict") {
    return `Evaluate the current state and submit a verdict: ${gate.options.join(" or ")}.`;
  }
  return `Complete the work for state ${stateName} and ensure the verification command passes.`;
};

// --- Role override resolution ---

/**
 * Apply project config overrides to a workflow role definition.
 *
 * 1. If `projectConfig.roles[roleName]` exists, merge its fields over
 *    the workflow default.
 * 2. If the result has `personaTags` (from config or workflow), resolve
 *    them against `projectConfig.team` to build the `personaPool`.
 *    Team members whose `tags` array contains ANY of the personaTags
 *    are included. This replaces any existing `personaPool`.
 */
export const applyRoleOverrides = (
  workflowRole: WorkflowDefinition["roles"][string],
  roleName: string,
  projectConfig?: ProjectConfig,
): WorkflowDefinition["roles"][string] => {
  if (!projectConfig) {
    return workflowRole;
  }

  const override = projectConfig.roles?.[roleName];
  if (
    !override &&
    !workflowRole.personaPool &&
    !("personaTags" in workflowRole)
  ) {
    return workflowRole;
  }

  // Start with a shallow copy of the workflow role
  let merged = { ...workflowRole };

  // Apply explicit config overrides
  if (override) {
    if (override.agent) merged.agent = override.agent;
    if (override.persona) merged.persona = override.persona;
    if (override.personaPool) merged.personaPool = override.personaPool;
    if (override.personaFrom) merged.personaFrom = override.personaFrom;
    if (override.tools) merged.tools = override.tools;
    if (override.fileScope) {
      merged.fileScope = {
        writable:
          override.fileScope.writable ?? workflowRole.fileScope.writable,
        readable:
          override.fileScope.readable ?? workflowRole.fileScope.readable,
      };
    }
  }

  // Resolve personaTags → personaPool from team members
  const tags = override?.personaTags;
  if (tags && tags.length > 0 && projectConfig.team.length > 0) {
    const tagSet = new Set(tags);
    const matchingPersonas = projectConfig.team
      .filter((member) => member.tags?.some((tag) => tagSet.has(tag)))
      .map((member) => member.persona);

    if (matchingPersonas.length > 0) {
      // Pool takes precedence — strip fixed persona
      const { persona: _fixed, ...withoutPersona } = merged;
      merged = { ...withoutPersona, personaPool: matchingPersonas };
    }
  }

  return merged;
};

// --- Persona from params ---

/**
 * If the role has `personaFrom`, resolve the persona file path from the
 * workflow's runtime params. This is how a subworkflow receives its
 * persona from the parent — e.g. a TDD turn receives the turn-taker's
 * persona via `inputMap: { turn_persona: "params.persona_a" }` and each
 * role in the turn has `personaFrom: "turn_persona"`.
 *
 * When `personaFrom` resolves to a string, it takes precedence over
 * both `persona` and `personaPool` (since the persona is being
 * explicitly assigned for this dispatch).
 */
export const resolvePersonaFromParams = (
  role: WorkflowDefinition["roles"][string],
  params: Record<string, unknown>,
): WorkflowDefinition["roles"][string] => {
  if (!role.personaFrom) {
    return role;
  }

  const personaPath = params[role.personaFrom];
  if (typeof personaPath !== "string") {
    return role;
  }

  // Clear pool — param-specified persona is a direct assignment
  const { personaPool: _pool, ...rest } = role;
  return {
    ...rest,
    persona: personaPath,
  };
};

// --- Persona rotation ---

/**
 * If the role has a personaPool, pick the next persona by counting how many
 * times *this specific role* has been dispatched (based on workflow history
 * entries for states assigned to this role) and rotating round-robin.
 *
 * Only states assigned to `roleName` in the workflow definition are counted,
 * so interleaved dispatches of other roles (e.g. domain_reviewer between
 * ping and pong) don't shift the rotation index.
 *
 * Returns a shallow copy of the role definition with `persona` set.
 * If the role already has a fixed `persona` or no pool, returns as-is.
 */
export const resolvePersonaForDispatch = (
  role: WorkflowDefinition["roles"][string],
  roleName: string,
  runtimeState: WorkflowRuntimeState,
  workflowDefinition: WorkflowDefinition,
): WorkflowDefinition["roles"][string] => {
  if (!role.personaPool || role.personaPool.length === 0) {
    return role;
  }

  // Build the set of state names assigned to this role
  const statesForRole = new Set<string>();
  for (const [stateName, stateDef] of Object.entries(
    workflowDefinition.states,
  )) {
    if ("assign" in stateDef && stateDef.assign === roleName) {
      statesForRole.add(stateName);
    }
  }

  // Count prior dispatches of this role only (exclude the last history
  // entry which is the current dispatch being set up right now)
  const priorHistory = runtimeState.history.slice(0, -1);
  const roleDispatchCount = priorHistory.filter((entry) =>
    statesForRole.has(entry.state),
  ).length;

  const persona = role.personaPool[
    roleDispatchCount % role.personaPool.length
  ] as string;

  return { ...role, persona };
};

// --- Subworkflow helpers ---

/**
 * Resolve a workflow reference. If it starts with "$", look it up in
 * params.slots (e.g. "$build" → params.slots.build). Otherwise return as-is.
 */
export const resolveWorkflowSlot = (
  workflow: string,
  params: Record<string, unknown>,
): string => {
  if (!workflow.startsWith("$")) {
    return workflow;
  }

  const slotName = workflow.slice(1);
  const slots = params.slots as Record<string, string> | undefined;
  if (!slots || typeof slots[slotName] !== "string") {
    throw new Error(`Subworkflow slot "${slotName}" not found in params.slots`);
  }

  return slots[slotName] as string;
};

/**
 * Resolve inputMap dotted paths against the parent runtime state.
 *
 * Supported root segments:
 *   - "params.x"          → parentState.params.x
 *   - "evidence.STATE.key" → parentState.evidence.STATE.key
 *
 * Returns a flat Record<string, unknown> suitable as child params.
 */
export const resolveInputMap = (
  inputMap: Record<string, string>,
  parentState: WorkflowRuntimeState,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [childParam, path] of Object.entries(inputMap)) {
    result[childParam] = getByDottedPath(parentState, path);
  }

  return result;
};

const getByDottedPath = (obj: unknown, dottedPath: string): unknown => {
  const segments = dottedPath.split(".");
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

// --- Exported pure builders ---

export interface BuildAgentPromptInput {
  role: string;
  roleDefinition: WorkflowDefinition["roles"][string];
  workflowId: string;
  workflowDefinition: WorkflowDefinition;
  state: string;
  stateDefinition: AgentState;
  projectConfig?: ProjectConfig | undefined;
  cwd: string;
}

export const buildAgentPrompt = (input: BuildAgentPromptInput): string => {
  const sections: string[] = [];

  // 1. Persona
  if (input.roleDefinition.persona) {
    const persona = readPersona(input.roleDefinition.persona, input.cwd);
    if (persona) {
      sections.push(`## Persona\n\n${persona.trim()}`);
    }
  }

  // 2. Agent definition
  const agentDef = resolveAgentDefinition(
    input.roleDefinition.agent,
    input.cwd,
  );
  if (agentDef) {
    sections.push(
      `## Agent Definition (${input.roleDefinition.agent})\n\n${agentDef.trim()}`,
    );
  }

  // 3. Project context
  if (input.projectConfig) {
    const pc = input.projectConfig;
    sections.push(
      `## Project Context\n\n- Project: ${pc.name}\n- Flavor: ${pc.flavor}\n- Test runner: ${pc.testRunner}\n- Build command: ${pc.buildCommand}\n- Source directory: ${pc.srcDir}\n- Test directory: ${pc.testDir}\n- Autonomy level: ${pc.autonomyLevel}`,
    );
  }

  // 4. Workflow context
  const gate = input.stateDefinition.gate;
  const fileScopeLines: string[] = [];
  if (input.roleDefinition.fileScope.writable.length > 0) {
    fileScopeLines.push(
      `- Writable: ${input.roleDefinition.fileScope.writable.join(", ")}`,
    );
  } else {
    fileScopeLines.push("- Writable: (none — read-only role)");
  }
  if (input.roleDefinition.fileScope.readable.length > 0) {
    fileScopeLines.push(
      `- Readable: ${input.roleDefinition.fileScope.readable.join(", ")}`,
    );
  }

  sections.push(
    `## Workflow Context\n\n- Workflow: ${input.workflowDefinition.name} — ${input.workflowDefinition.description}\n- Workflow ID: ${input.workflowId}\n- Current state: ${input.state}\n- Your role: ${input.role}\n\n### File Scope\n${fileScopeLines.join("\n")}\n\n### Gate Requirements\n${formatGateSchema(gate)}`,
  );

  // 5. Tool instructions
  sections.push(`## Available Tools

### submit_evidence
Use this tool when you have completed the work for the current state. Parameters:
- \`state\`: Must be "${input.state}" (the current state name)
- \`result\`: ${gate.kind === "verdict" ? `One of: ${gate.options.join(", ")}` : '"pass" on success'}
- \`evidence\`: ${gate.kind === "evidence" ? `A JSON object with the required fields: ${Object.keys(gate.schema).join(", ")}` : "A JSON object with any supporting details"}

### send_message
Send a message to another agent in this workflow. Parameters:
- \`to\`: The target agent ID
- \`type\`: Message type (e.g., "question", "info", "request")
- \`payload\`: Any JSON payload

### check_inbox
Check for messages from other agents. Call with no parameters.

**Important**: Always call \`submit_evidence\` when your work is complete. Do not exit without submitting evidence — the workflow cannot advance otherwise.`);

  return `# Role: ${input.role}\n\n${sections.join("\n\n---\n\n")}`;
};

export interface BuildAgentTaskInput {
  workflowId: string;
  state: string;
  stateDefinition: AgentState;
  runtimeState: WorkflowRuntimeState;
  projectConfig?: ProjectConfig | undefined;
}

export const buildAgentTask = (input: BuildAgentTaskInput): string => {
  const sections: string[] = [];
  const gate = input.stateDefinition.gate;

  // Header
  sections.push(
    `# Task: Execute state ${input.state} for workflow ${input.workflowId}`,
  );

  // 1. State-specific instructions
  sections.push(
    `## Instructions\n\n${buildStateInstructions(input.state, gate, input.projectConfig)}`,
  );

  // 2. Evidence from prior states
  const evidenceEntries = Object.entries(input.runtimeState.evidence);
  if (evidenceEntries.length > 0) {
    const evidenceLines = evidenceEntries
      .map(
        ([stateName, data]) =>
          `### ${stateName}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
      )
      .join("\n\n");
    sections.push(`## Evidence from Prior States\n\n${evidenceLines}`);
  }

  // 3. Gate schema
  sections.push(
    `## Gate Schema (what you must submit)\n\n${formatGateSchema(gate)}`,
  );

  if (gate.kind === "evidence") {
    sections.push(
      `### Example submit_evidence call\n\`\`\`json\n{\n  "state": "${input.state}",\n  "result": "pass",\n  "evidence": {\n${Object.entries(
        gate.schema,
      )
        .map(([key, type]) => `    "${key}": "<${type}>"`)
        .join(",\n")}\n  }\n}\n\`\`\``,
    );
  } else if (gate.kind === "verdict") {
    sections.push(
      `### Example submit_evidence call\n\`\`\`json\n{\n  "state": "${input.state}",\n  "result": "${gate.options[0] ?? "pass"}",\n  "evidence": {\n    "rationale": "your reasoning here"\n  }\n}\n\`\`\``,
    );
  }

  // 4. Retry context
  if (input.runtimeState.retry_count > 0) {
    const lastHistory = input.runtimeState.history.at(-1);
    const failureMessage =
      lastHistory?.last_failure ?? "Previous attempt failed gate verification";
    sections.push(
      `## Retry Context\n\nThis is retry #${input.runtimeState.retry_count}. Previous failure: ${failureMessage}\n\nPlease address the failure reason before resubmitting evidence.`,
    );
  }

  // 5. Workflow params if present
  const paramEntries = Object.entries(input.runtimeState.params);
  if (paramEntries.length > 0) {
    sections.push(
      `## Workflow Parameters\n\n${paramEntries.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
};

export const buildScopeExtension = (input: {
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
