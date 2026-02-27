import type {
  CommandGate,
  EvidenceGate,
  SubworkflowState,
  VerdictGate,
  WorkflowDefinition,
} from "./types";

export const defineWorkflow = (
  workflow: WorkflowDefinition,
): WorkflowDefinition => workflow;

export const evidence = (gate: {
  schema: Record<string, string>;
  verify?: { command: string; expectExitCode?: number };
}): EvidenceGate => ({
  kind: "evidence",
  schema: gate.schema,
  ...(gate.verify ? { verify: gate.verify } : {}),
});

export const verdict = (gate: { options: string[] }): VerdictGate => ({
  kind: "verdict",
  options: gate.options,
});

export const command = (gate: {
  verify: { command: string; expectExitCode?: number };
}): CommandGate => ({
  kind: "command",
  verify: gate.verify,
});

/**
 * Define a state that delegates to a child workflow.
 *
 * `workflow` can be a literal name ("tdd-ping-pong") or a slot reference
 * ("$build") that is resolved from `params.slots` at runtime.
 *
 * `inputMap` maps child param names to dotted paths in the parent runtime:
 *   - "params.scenario"                → parent's params.scenario
 *   - "evidence.SETUP.acceptance_criteria" → parent's evidence from SETUP
 *
 * Transitions key on the child's terminal result: "success" or "failure".
 */
export const subworkflow = (config: {
  workflow: string;
  inputMap?: Record<string, string>;
  transitions: Record<string, string>;
  maxRetries?: number;
}): SubworkflowState => ({
  type: "subworkflow",
  workflow: config.workflow,
  ...(config.inputMap ? { inputMap: config.inputMap } : {}),
  transitions: config.transitions,
  // Stryker disable next-line all: optional field propagation
  ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
});
