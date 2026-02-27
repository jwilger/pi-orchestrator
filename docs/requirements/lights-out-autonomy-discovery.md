# Discovery: Lights-Out Autonomy Requirements

## Problem statement

Orchestra should run as a default-autonomous software factory where workflows continue without manual nudging and stop only at explicit human gates.

## Desired outcome

At maximum autonomy, the path should be:

**Requirements in -> Working software out**

without human intervention except where project/workflow policy explicitly requires review or approval.

## Current friction

- Autopilot exists but is command-driven, not policy-driven.
- Workflow pause conditions are implicit in behavior instead of explicit in requirements.
- Restart/resume behavior for long-running autonomous execution is not fully captured as a requirement contract.
- Human review cadence exists at project config level but needs concrete runtime semantics.

## Stakeholder intent (captured)

1. Autopilot should be the default mode for high-autonomy projects.
2. Workflow should only stop at states that explicitly require human action.
3. A project should be able to configure autonomy behavior without rewriting core workflows.
4. Slice-by-slice PR creation, checks, merge, and sync should run continuously when allowed by policy.
5. Orchestrator must be safe and observable: clear halt reasons and restart behavior.

## Requirement themes

- **Autonomy-by-default policy**
- **Explicit human-gate semantics**
- **Persistence/restart guarantees**
- **Deterministic halt reasons**
- **Operational observability**
- **Policy-aware PR automation**

## Non-goals

- Forcing lights-out mode in assisted/manual projects.
- Removing all human review; only making it explicit and policy-driven.

## Open questions

1. Should human-gate states be first-class (`type: "human"`) or metadata (`requiresHuman: true`)?
2. Should `humanReviewCadence` map directly to auto-generated human gates in workflows?
3. What is the default error budget and retry policy before escalation?
4. Should autopilot be globally configurable, per workflow instance, or both?
5. What minimum observability signals are required in `/orchestra panel` for unattended runs?
