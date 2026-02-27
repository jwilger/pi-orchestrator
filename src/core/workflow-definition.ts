import type {
  CommandGate,
  EvidenceGate,
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
