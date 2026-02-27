# Planning: Lights-Out Autonomy Requirements

This plan translates discovery findings into implementable requirement work.

## Objective

Define and document runtime requirements so Orchestra operates autonomously by default and pauses only at explicit human-gate states.

## Requirement specification backlog

### R1. Autonomy policy contract
- Add explicit requirement language for project-level autonomy policy.
- Define defaults for `full`, `assisted`, `manual`.
- Define precedence: project policy vs workflow override vs per-run override.

### R2. Explicit human-gate semantics
- Define one canonical mechanism for human-required states.
- Specify that non-human states must remain autopilot-eligible.
- Define required UX copy for halt reason and next action.

### R3. Autopilot lifecycle contract
- Define startup behavior: when autopilot auto-starts.
- Define persistence behavior across session restarts.
- Define stop behavior: terminal state, human gate, manual stop, unrecoverable error.

### R4. Reliability and escalation policy
- Define retry budget and exponential/backoff expectations.
- Define escalation thresholds and required evidence payload.
- Define how paused workflows are reported and resumed.

### R5. PR automation policy requirements
- Define required checks and merge strategy policy mapping.
- Define failure semantics for check timeout/failures.
- Define branch sync/cleanup behavior after merge.

### R6. Observability requirements
- Define minimum dashboard/control-panel fields for unattended operation:
  - workflow state
  - autopilot status
  - halt reason
  - retry/error streak
  - current/next action

### R7. Security/permissions requirements
- Define token/auth preconditions for autonomous PR actions.
- Define safe-fail behavior when auth/policy blocks merge.

## Acceptance criteria for requirement completion

1. Requirements are documented in a canonical PRD-adjacent location.
2. Each requirement area (R1-R7) includes:
   - behavior contract
   - rationale
   - measurable acceptance criteria
3. Requirements distinguish policy from implementation detail.
4. Requirements are reviewable by domain + systems review roles.

## Suggested implementation order (after requirements PR)

1. R2 explicit human-gate semantics
2. R1 policy contract + default-on behavior for full autonomy
3. R3 lifecycle persistence/resume
4. R6 observability fields
5. R4 retry/escalation hardening
6. R5 PR automation policy alignment
7. R7 auth/policy edge handling
