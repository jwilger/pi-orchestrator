export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkflowId = Brand<string, "WorkflowId">;
export type WorkflowType = Brand<string, "WorkflowType">;
export type AgentId = Brand<string, "AgentId">;
export type MessageId = Brand<string, "MessageId">;

export const asWorkflowId = (value: string): WorkflowId => value as WorkflowId;
export const asWorkflowType = (value: string): WorkflowType =>
  value as WorkflowType;
export const asAgentId = (value: string): AgentId => value as AgentId;
export const asMessageId = (value: string): MessageId => value as MessageId;

export type GateKind = "evidence" | "verdict" | "command";

export interface RoleDefinition {
  agent: string;
  persona?: string;
  personaPool?: string[];
  /**
   * Name of a workflow param whose value is a persona file path.
   * Resolved at dispatch time from the workflow runtime's params.
   * Takes precedence over `persona` and `personaPool`.
   */
  personaFrom?: string;
  tools: string[];
  fileScope: {
    writable: string[];
    readable: string[];
  };
  freshPerState?: boolean;
}

export interface EvidenceGate {
  kind: "evidence";
  schema: Record<string, string>;
  verify?: VerificationCommand;
}

export interface VerdictGate {
  kind: "verdict";
  options: string[];
}

export interface CommandGate {
  kind: "command";
  verify: VerificationCommand;
}

export type GateDefinition = EvidenceGate | VerdictGate | CommandGate;

export type VerificationCommand = {
  command: string;
  expectExitCode?: number;
};

export interface ActionState {
  type: "action";
  commands: string[];
  transitions: Record<string, string>;
  gate?: CommandGate;
}

export interface TerminalState {
  type: "terminal";
  result: "success" | "failure";
  action?: string;
}

export interface AgentState {
  assign: string;
  gate: GateDefinition;
  transitions: Record<string, string>;
  maxRetries?: number;
  inputFrom?: string[];
}

/**
 * A state that delegates to a child workflow. The child runs to completion
 * (terminal state), then its result ("success" | "failure") drives the
 * parent transition.
 *
 * `workflow` can be:
 *   - A literal workflow name: "tdd-ping-pong"
 *   - A slot reference:        "$build"  (resolved from parent params.slots)
 *
 * `inputMap` selects which parent evidence/params to pass as the child's
 * params. Keys are child param names, values are dotted paths into the
 * parent runtime (e.g. "evidence.SETUP.acceptance_criteria", "params.scenario").
 *
 * When the child completes, its evidence is merged into the parent under
 * `evidence.<stateName>.*`.
 */
export interface SubworkflowState {
  type: "subworkflow";
  workflow: string;
  inputMap?: Record<string, string>;
  transitions: Record<string, string>;
  maxRetries?: number;
}

export type WorkflowStateDefinition =
  | AgentState
  | ActionState
  | TerminalState
  | SubworkflowState;

export interface WorkflowDefinition {
  name: string;
  description: string;
  params?: Record<
    string,
    { type: string; required?: boolean; default?: unknown }
  >;
  roles: Record<string, RoleDefinition>;
  states: Record<string, WorkflowStateDefinition>;
  initialState?: string;
}

export interface WorkflowStateHistory {
  state: string;
  entered_at: string;
  exited_at?: string;
  result?: string;
  retries: number;
  last_failure?: string;
}

export interface WorkflowRuntimeState {
  workflow_id: WorkflowId;
  workflow_type: WorkflowType;
  current_state: string;
  retry_count: number;
  paused: boolean;
  params: Record<string, unknown>;
  history: WorkflowStateHistory[];
  evidence: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** If this workflow was started by a subworkflow state, tracks the parent. */
  parent?: {
    workflow_id: WorkflowId;
    state: string;
  };
  /** Active child workflow IDs launched from subworkflow states. */
  children?: Record<string, WorkflowId>;
}

export interface Message {
  id: MessageId;
  from: AgentId;
  to: AgentId;
  type: string;
  workflow_id?: WorkflowId;
  phase?: string;
  timestamp: string;
  payload: unknown;
  requires_ack: boolean;
}
