import type { WorkflowDefinition, WorkflowRuntimeState } from "../core/types";

export interface EvidenceSchemaEntry {
  workflow: string;
  state: string;
  schema: Record<string, string>;
}

export interface EvidenceValidationDiagnostic {
  state: string;
  ok: boolean;
  errors: string[];
}

const matchesType = (value: unknown, expected: string): boolean => {
  if (expected === "string") {
    return typeof value === "string";
  }

  if (expected === "number") {
    return typeof value === "number";
  }

  if (expected === "boolean") {
    return typeof value === "boolean";
  }

  if (expected === "array") {
    return Array.isArray(value);
  }

  if (expected === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  return true;
};

export const collectEvidenceSchemas = (
  definitions: WorkflowDefinition[],
): EvidenceSchemaEntry[] => {
  const entries: EvidenceSchemaEntry[] = [];
  for (const definition of definitions) {
    for (const [state, stateDef] of Object.entries(definition.states)) {
      if (!("gate" in stateDef) || stateDef.gate.kind !== "evidence") {
        continue;
      }

      entries.push({
        workflow: definition.name,
        state,
        schema: stateDef.gate.schema,
      });
    }
  }

  return entries;
};

export const validateEvidenceForState = (
  state: string,
  schema: Record<string, string>,
  evidence: Record<string, unknown>,
): EvidenceValidationDiagnostic => {
  const errors: string[] = [];

  for (const [key, typeName] of Object.entries(schema)) {
    if (!(key in evidence)) {
      errors.push(`missing key: ${key}`);
      continue;
    }

    if (!matchesType(evidence[key], typeName)) {
      const actual = Array.isArray(evidence[key])
        ? "array"
        : evidence[key] === null
          ? "null"
          : typeof evidence[key];
      errors.push(
        `type mismatch for ${key}: expected ${typeName}, got ${actual}`,
      );
    }
  }

  return {
    state,
    ok: errors.length === 0,
    errors,
  };
};

export const buildWorkflowEvidenceDiagnostics = (
  workflow: WorkflowRuntimeState,
): EvidenceValidationDiagnostic[] => {
  const diagnostics: EvidenceValidationDiagnostic[] = [];
  for (const historyEntry of workflow.history) {
    const evidence = workflow.evidence[historyEntry.state] as
      | { validation_errors?: unknown }
      | undefined;
    const errors = Array.isArray(evidence?.validation_errors)
      ? evidence.validation_errors.filter((value) => typeof value === "string")
      : [];

    diagnostics.push({
      state: historyEntry.state,
      ok: errors.length === 0,
      errors,
    });
  }

  return diagnostics;
};
