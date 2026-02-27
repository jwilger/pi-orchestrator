import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessageBus } from "../core/message-bus";
import { StateStore } from "../core/state-store";
import { WorkflowEngine } from "../core/workflow-engine";
import {
  buildWorkflowEvidenceDiagnostics,
  collectEvidenceSchemas,
} from "../evidence/schema-registry";
import {
  type DashboardSection,
  buildActionLines,
  buildCommandHelpLines,
  buildInteractiveDashboardLines,
  buildOverviewLines,
  buildRetroApplyLines,
  buildTuningLines,
  buildWorkflowDetailLines,
  buildWorkflowLines,
} from "../observability/dashboard";
import { bootstrapProjectConfig } from "../project/bootstrap";
import { loadProjectConfig } from "../project/config";
import { buildCutlineStatus } from "../project/cutline";
import { buildReadinessReport } from "../project/readiness";
import { RetroProposalApplier } from "../retro/proposal-applier";
import { RetroProposalArtifact } from "../retro/proposal-artifact";
import {
  type HealthCheckResult,
  HealthScheduler,
} from "../runtime/health-scheduler";
import {
  type PaneSpawnSpec,
  ZellijSupervisor,
} from "../runtime/zellij-supervisor";
import { ModelTuner } from "../tuning/model-tuner";

const asToolResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export default function (pi: ExtensionAPI): void {
  const root = path.join(process.cwd(), ".orchestra");
  const store = new StateStore(root);
  store.ensure();

  let projectConfig = loadProjectConfig(process.cwd());
  const engine = new WorkflowEngine(pi, process.cwd(), store);
  const tuner = new ModelTuner(path.join(root, "tuning"));
  const retro = new RetroProposalApplier(process.cwd());
  const retroArtifact = new RetroProposalArtifact(process.cwd());
  const zellij = new ZellijSupervisor(pi);
  const bus = new MessageBus(
    path.join(root, "bus.sock"),
    path.join(root, "bus.wal"),
  );

  let lastHealthResults: HealthCheckResult[] = [];
  let lastHealthEscalation:
    | {
        at: string;
        streak: number;
        failing: HealthCheckResult[];
        pausedWorkflows: string[];
      }
    | undefined;
  const scheduler = new HealthScheduler(
    30_000,
    [
      async () => {
        const workflows = engine.list();
        const paused = workflows.filter((workflow) => workflow.paused).length;
        return {
          name: "workflows",
          ok: true,
          message: `workflows=${workflows.length} paused=${paused}`,
        };
      },
      async () => {
        const panes = await zellij.listPanes();
        return {
          name: "panes",
          ok: panes.length > 0 || engine.list().length === 0,
          message: `panes=${panes.length}`,
        };
      },
      () => {
        const recommendations = tuner.listRecommendations();
        return {
          name: "tuning",
          ok: true,
          message: `recommendations=${recommendations.length}`,
        };
      },
    ],
    (results) => {
      lastHealthResults = results;
    },
    (escalation) => {
      const pausedWorkflows = engine
        .list()
        .filter((workflow) => !workflow.paused)
        .map((workflow) => {
          engine.pause(workflow.workflow_id as unknown as string);
          return workflow.workflow_id as unknown as string;
        });

      lastHealthEscalation = {
        ...escalation,
        pausedWorkflows,
      };
    },
  );

  let initialized = false;
  const autopilotTimers = new Map<string, ReturnType<typeof setInterval>>();
  const autopilotTokens = new Map<string, string>();

  const isWorkflowTerminal = (workflowId: string): boolean => {
    const workflow = engine.get(workflowId);
    if (!workflow) {
      return true;
    }

    const definition = engine.getDefinition(
      workflow.workflow_type as unknown as string,
    );
    const stateDefinition = definition?.states[workflow.current_state];
    if (!stateDefinition) {
      return false;
    }

    return "type" in stateDefinition && stateDefinition.type === "terminal";
  };

  const startAutopilot = (
    workflowId: string,
    ctx?: ExtensionCommandContext,
  ): { started: boolean; reason: string } => {
    if (autopilotTimers.has(workflowId)) {
      return { started: false, reason: "already running" };
    }

    if (!engine.get(workflowId)) {
      return { started: false, reason: "unknown workflow" };
    }

    let running = false;
    const tick = async () => {
      if (running) {
        return;
      }
      running = true;

      try {
        const workflow = engine.get(workflowId);
        if (!workflow) {
          stopAutopilot(workflowId);
          return;
        }

        if (workflow.paused) {
          return;
        }

        if (isWorkflowTerminal(workflowId)) {
          stopAutopilot(workflowId);
          ctx?.ui.notify(`autopilot complete: ${workflowId}`, "info");
          return;
        }

        const historyEntry = workflow.history.at(-1);
        const token = historyEntry
          ? `${workflow.current_state}:${historyEntry.entered_at}:${historyEntry.retries}`
          : workflow.current_state;

        if (autopilotTokens.get(workflowId) === token) {
          return;
        }

        autopilotTokens.set(workflowId, token);
        const result = await engine.dispatchCurrentState(workflowId);
        if (!result.dispatched && result.details.includes("terminal")) {
          stopAutopilot(workflowId);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        ctx?.ui.notify(`autopilot error (${workflowId}): ${message}`, "error");
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, 2000);
    autopilotTimers.set(workflowId, timer);
    void tick();
    return { started: true, reason: "started" };
  };

  const stopAutopilot = (workflowId: string): boolean => {
    const timer = autopilotTimers.get(workflowId);
    if (!timer) {
      return false;
    }
    clearInterval(timer);
    autopilotTimers.delete(workflowId);
    autopilotTokens.delete(workflowId);
    return true;
  };

  const stopAllAutopilot = (): number => {
    const ids = [...autopilotTimers.keys()];
    for (const id of ids) {
      stopAutopilot(id);
    }
    return ids.length;
  };

  const listAutopilot = (): string[] => [...autopilotTimers.keys()];

  const initialize = async (): Promise<void> => {
    if (initialized) {
      return;
    }

    await engine.loadWorkflows();
    tuner.ensure();
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
    scheduler.start();
    const results = await scheduler.runOnce();
    const failing = results.filter((result) => !result.ok).length;
    ctx.ui.setStatus(
      "orchestra",
      failing > 0
        ? `orchestra: ready (health warnings=${failing})`
        : "orchestra: ready",
    );
  });

  pi.on("session_shutdown", async () => {
    scheduler.stop();
    stopAllAutopilot();
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
    name: "orchestra_help",
    label: "Orchestra Help",
    description: "Show available orchestra commands and controls",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      return asToolResult({ commands: buildCommandHelpLines() });
    },
  });

  pi.registerTool({
    name: "orchestra_cutline_status",
    label: "Orchestra Cutline Status",
    description: "Show what is in-branch vs deferred",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      return asToolResult(buildCutlineStatus());
    },
  });

  pi.registerTool({
    name: "orchestra_readiness",
    label: "Orchestra Readiness",
    description: "Show go/no-go readiness summary for this branch",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      const cutline = buildCutlineStatus();
      const report = buildReadinessReport(cutline);
      return asToolResult({ cutline, report });
    },
  });

  pi.registerTool({
    name: "orchestra_project_status",
    label: "Orchestra Project Status",
    description: "Show loaded orchestra project configuration",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      projectConfig = loadProjectConfig(process.cwd());
      return asToolResult(projectConfig);
    },
  });

  pi.registerTool({
    name: "orchestra_project_bootstrap",
    label: "Orchestra Project Bootstrap",
    description: "Generate .orchestra/project.ts from packaged defaults",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ default: false })),
      name: Type.Optional(Type.String()),
      flavor: Type.Optional(
        Type.Union([
          Type.Literal("event-modeled"),
          Type.Literal("traditional-prd"),
        ]),
      ),
      autonomyLevel: Type.Optional(
        Type.Union([
          Type.Literal("full"),
          Type.Literal("assisted"),
          Type.Literal("manual"),
        ]),
      ),
      humanReviewCadence: Type.Optional(
        Type.Union([
          Type.Literal("every-slice"),
          Type.Literal("every-n"),
          Type.Literal("end"),
        ]),
      ),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const result = bootstrapProjectConfig(process.cwd(), {
        force: params.force ?? false,
        overrides: {
          ...(params.name ? { name: params.name } : {}),
          ...(params.flavor ? { flavor: params.flavor } : {}),
          ...(params.autonomyLevel
            ? { autonomyLevel: params.autonomyLevel }
            : {}),
          ...(params.humanReviewCadence
            ? { humanReviewCadence: params.humanReviewCadence }
            : {}),
        },
      });
      projectConfig = loadProjectConfig(process.cwd());
      return asToolResult({ result, projectConfig });
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
    name: "orchestra_tuning_record",
    label: "Orchestra Tuning Record",
    description: "Record a model performance sample for tuning",
    parameters: Type.Object({
      model: Type.String(),
      role: Type.String(),
      phase: Type.String(),
      quality: Type.Number({ minimum: 0, maximum: 1 }),
      cost_usd: Type.Number({ minimum: 0 }),
      latency_ms: Type.Number({ minimum: 0 }),
      retries: Type.Number({ minimum: 0 }),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const sample = tuner.recordSample(params);
      const recommendations = tuner.generateRecommendations();
      return asToolResult({ sample, recommendations });
    },
  });

  pi.registerTool({
    name: "orchestra_tuning_status",
    label: "Orchestra Tuning Status",
    description: "Show tuner metrics and recommendations",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      return asToolResult({
        sampleCount: tuner.listSamples().length,
        summaries: tuner.summarizeByRolePhase(),
        recommendations: tuner.listRecommendations(),
        experiments: tuner.listExperiments(),
        assignments: tuner.listAssignments(),
      });
    },
  });

  pi.registerTool({
    name: "orchestra_tuning_experiment_create",
    label: "Orchestra Tuning Experiment Create",
    description:
      "Create tuning A/B experiments from recommendation or explicit models",
    parameters: Type.Object({
      role: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
      baselineModel: Type.Optional(Type.String()),
      challengerModel: Type.Optional(Type.String()),
      fromRecommendations: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      if (params.fromRecommendations) {
        const created = tuner.createExperimentsFromRecommendations();
        return asToolResult({ created, total: created.length });
      }

      if (
        !params.role ||
        !params.phase ||
        !params.baselineModel ||
        !params.challengerModel
      ) {
        throw new Error(
          "role, phase, baselineModel, and challengerModel are required unless fromRecommendations=true",
        );
      }

      const created = tuner.createExperiment({
        role: params.role,
        phase: params.phase,
        baseline_model: params.baselineModel,
        challenger_model: params.challengerModel,
      });
      return asToolResult({ created });
    },
  });

  pi.registerTool({
    name: "orchestra_tuning_experiment_run",
    label: "Orchestra Tuning Experiment Run",
    description: "Run pending tuning A/B experiments and apply rollback policy",
    parameters: Type.Object({
      minSamplesPerModel: Type.Optional(Type.Number({ minimum: 1 })),
      rollbackDeltaThreshold: Type.Optional(Type.Number({ minimum: 0 })),
      costWeight: Type.Optional(Type.Number({ minimum: 0 })),
      latencyWeight: Type.Optional(Type.Number({ minimum: 0 })),
      retryWeight: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const result = tuner.runExperiments(params);
      return asToolResult(result);
    },
  });

  pi.registerTool({
    name: "orchestra_pane_spawn",
    label: "Orchestra Pane Spawn",
    description: "Spawn a zellij pane for orchestration tasks",
    parameters: Type.Object({
      name: Type.String(),
      cwd: Type.String(),
      command: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      return asToolResult(await zellij.spawnPane(params));
    },
  });

  pi.registerTool({
    name: "orchestra_pane_status",
    label: "Orchestra Pane Status",
    description: "List zellij panes for lifecycle supervision",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      const panes = await zellij.listPanes();
      return asToolResult({ paneCount: panes.length, panes });
    },
  });

  pi.registerTool({
    name: "orchestra_pane_recover",
    label: "Orchestra Pane Recover",
    description: "Reconcile expected zellij panes and respawn missing panes",
    parameters: Type.Object({
      expected: Type.Array(
        Type.Object({
          name: Type.String(),
          cwd: Type.String(),
          command: Type.Array(Type.String()),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      return asToolResult({
        ...(await zellij.reconcilePanes(params.expected)),
        tracked: zellij.getTrackedPaneIds(),
      });
    },
  });

  pi.registerTool({
    name: "orchestra_pane_focus",
    label: "Orchestra Pane Focus",
    description: "Focus a zellij pane by id or name",
    parameters: Type.Object({
      paneId: Type.Optional(Type.String()),
      paneName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const ok = params.paneId
        ? await zellij.focusPane(params.paneId)
        : params.paneName
          ? await zellij.focusPaneByName(params.paneName)
          : false;
      return asToolResult({ ok });
    },
  });

  pi.registerTool({
    name: "orchestra_pane_close",
    label: "Orchestra Pane Close",
    description: "Close a zellij pane by id or name",
    parameters: Type.Object({
      paneId: Type.Optional(Type.String()),
      paneName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const ok = params.paneId
        ? await zellij.closePane(params.paneId)
        : params.paneName
          ? await zellij.closePaneByName(params.paneName)
          : false;
      return asToolResult({ ok });
    },
  });

  pi.registerTool({
    name: "orchestra_retro_apply",
    label: "Orchestra Retro Apply",
    description: "Apply structured retro proposals from JSON",
    parameters: Type.Object({
      file: Type.Optional(Type.String()),
      workflowId: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const proposals = params.file
        ? retro.loadProposals(params.file)
        : retro.loadLatestProposals(params.workflowId);
      const results = retro.applyProposals(proposals, params.dryRun ?? true);
      return asToolResult({ proposalCount: proposals.length, results });
    },
  });

  pi.registerTool({
    name: "orchestra_retro_latest",
    label: "Orchestra Retro Latest",
    description: "Inspect latest retro proposal artifact",
    parameters: Type.Object({
      workflowId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const loaded = retro.loadLatestProposalsWithSource(params.workflowId);
      return asToolResult({
        source: loaded.source,
        proposalCount: loaded.proposals.length,
        proposals: loaded.proposals,
      });
    },
  });

  pi.registerTool({
    name: "orchestra_retro_materialize",
    label: "Orchestra Retro Materialize",
    description: "Materialize retro proposal artifact from workflow evidence",
    parameters: Type.Object({
      workflowId: Type.String(),
      dryRun: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const workflow = engine.get(params.workflowId);
      if (!workflow) {
        return asToolResult({ error: "unknown_workflow" });
      }

      const result = retroArtifact.materializeFromWorkflow(
        workflow,
        (filePath) => retro.loadProposals(filePath),
        params.dryRun ?? true,
      );
      return asToolResult(result);
    },
  });

  pi.registerTool({
    name: "orchestra_next_actions",
    label: "Orchestra Next Actions",
    description: "Suggest next actionable orchestra commands",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      const workflows = engine.list();
      return asToolResult({ actions: buildActionLines(workflows) });
    },
  });

  pi.registerTool({
    name: "orchestra_retro_pipeline",
    label: "Orchestra Retro Pipeline",
    description:
      "Materialize retro artifact from workflow evidence, then apply proposals",
    parameters: Type.Object({
      workflowId: Type.String(),
      apply: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const workflow = engine.get(params.workflowId);
      if (!workflow) {
        return asToolResult({ error: "unknown_workflow" });
      }

      const apply = params.apply ?? false;
      const materialized = retroArtifact.materializeFromWorkflow(
        workflow,
        (filePath) => retro.loadProposals(filePath),
        !apply,
      );
      const results = retro.applyProposals(materialized.proposals, !apply);
      return asToolResult({
        materialized,
        apply,
        results,
      });
    },
  });

  pi.registerTool({
    name: "orchestra_observability_status",
    label: "Orchestra Observability Status",
    description: "Summarize workflows, panes, and tuning health",
    parameters: Type.Object({}),
    async execute() {
      await initialize();
      const workflows = engine.list();
      const panes = await zellij.listPanes();
      const recommendations = tuner.listRecommendations();
      const loaded = retro.loadLatestProposalsWithSource();
      return asToolResult({
        workflowCount: workflows.length,
        pausedCount: workflows.filter((workflow) => workflow.paused).length,
        paneCount: panes.length,
        tuningRecommendationCount: recommendations.length,
        latestRetroSource: loaded.source,
        latestRetroCount: loaded.proposals.length,
        overviewLines: buildOverviewLines({
          workflows,
          paneCount: panes.length,
          recommendationCount: recommendations.length,
        }),
        workflowLines: buildWorkflowLines(workflows),
        tuningLines: buildTuningLines(recommendations),
        actionLines: buildActionLines(workflows),
      });
    },
  });

  pi.registerTool({
    name: "orchestra_dashboard_view",
    label: "Orchestra Dashboard View",
    description: "Render rich dashboard sections with table-oriented views",
    parameters: Type.Object({
      section: Type.Optional(
        Type.Union([
          Type.Literal("overview"),
          Type.Literal("workflows"),
          Type.Literal("tuning"),
          Type.Literal("panes"),
          Type.Literal("health"),
        ]),
      ),
      page: Type.Optional(Type.Number({ minimum: 1, default: 1 })),
      pageSize: Type.Optional(
        Type.Number({ minimum: 1, maximum: 25, default: 8 }),
      ),
    }),
    async execute(_toolCallId, params) {
      await initialize();
      const workflows = engine.list();
      const panes = await zellij.listPanes();
      const recommendations = tuner.listRecommendations();
      const experiments = tuner.listExperiments();
      const assignments = tuner.listAssignments();
      const checks = lastHealthResults;
      const section = parseDashboardSection(params.section);
      const lines = buildInteractiveDashboardLines({
        section,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 8,
        workflows,
        paneRows: panes.map((pane) => ({
          id: pane.id,
          name: pane.name ?? "(unnamed)",
        })),
        recommendations,
        experiments,
        assignments,
        healthChecks: checks,
      });

      return asToolResult({
        section,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 8,
        lines,
      });
    },
  });

  pi.registerTool({
    name: "orchestra_evidence_schema_registry",
    label: "Orchestra Evidence Schema Registry",
    description: "List evidence schemas by workflow and state",
    parameters: Type.Object({ workflow: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      await initialize();
      const entries = collectEvidenceSchemas(engine.listDefinitions());
      const filtered = params.workflow
        ? entries.filter((entry) => entry.workflow === params.workflow)
        : entries;
      return asToolResult({ count: filtered.length, entries: filtered });
    },
  });

  pi.registerTool({
    name: "orchestra_evidence_diagnostics",
    label: "Orchestra Evidence Diagnostics",
    description: "Show evidence validation diagnostics for a workflow instance",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_toolCallId, params) {
      await initialize();
      const workflow = engine.get(params.workflowId);
      if (!workflow) {
        return asToolResult({ error: "unknown_workflow" });
      }

      const diagnostics = buildWorkflowEvidenceDiagnostics(workflow);
      return asToolResult({
        workflowId: params.workflowId,
        diagnostics,
        failing: diagnostics.filter((entry) => !entry.ok).length,
      });
    },
  });

  pi.registerTool({
    name: "orchestra_workflow_detail",
    label: "Orchestra Workflow Detail",
    description: "Get detailed state lines for one workflow",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_toolCallId, params) {
      await initialize();
      const workflow = engine.get(params.workflowId);
      return asToolResult({
        workflow,
        lines: buildWorkflowDetailLines(workflow),
      });
    },
  });

  pi.registerTool({
    name: "orchestra_dispatch",
    label: "Orchestra Dispatch",
    description: "Dispatch current workflow state to assigned role",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_toolCallId, params) {
      await initialize();
      const dispatch = await engine.dispatchCurrentState(params.workflowId);
      return asToolResult(dispatch);
    },
  });

  pi.registerTool({
    name: "orchestra_health_status",
    label: "Orchestra Health Status",
    description: "Run or retrieve background health checks",
    parameters: Type.Object({ runNow: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      await initialize();
      const results = params.runNow
        ? await scheduler.runOnce()
        : lastHealthResults;
      return asToolResult({
        checks: results,
        failing: results.filter((result) => !result.ok).length,
        scheduler: scheduler.getState(),
        escalation: lastHealthEscalation,
      });
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
      await handleCommand(
        args,
        ctx,
        engine,
        tuner,
        zellij,
        retro,
        retroArtifact,
        projectConfig,
        scheduler,
        () => lastHealthResults,
        startAutopilot,
        stopAutopilot,
        listAutopilot,
      );
    },
  });
}

const parseJsonParams = (raw?: string): Record<string, unknown> => {
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("params must be a JSON object");
  }

  return parsed as Record<string, unknown>;
};

const parsePaneSpecs = (raw?: string): PaneSpawnSpec[] => {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("pane specs must be a JSON array");
  }

  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("pane spec must be an object");
    }

    const candidate = item as {
      name?: unknown;
      cwd?: unknown;
      command?: unknown;
    };

    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      throw new Error("pane spec name must be a non-empty string");
    }

    if (typeof candidate.cwd !== "string" || candidate.cwd.length === 0) {
      throw new Error("pane spec cwd must be a non-empty string");
    }

    if (
      !Array.isArray(candidate.command) ||
      candidate.command.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("pane spec command must be an array of strings");
    }

    return {
      name: candidate.name,
      cwd: candidate.cwd,
      command: candidate.command,
    };
  });
};

const parseDashboardSection = (input?: string): DashboardSection => {
  const section = input ?? "overview";
  if (
    section !== "overview" &&
    section !== "workflows" &&
    section !== "tuning" &&
    section !== "panes" &&
    section !== "health"
  ) {
    throw new Error(
      "dashboard section must be one of: overview, workflows, tuning, panes, health",
    );
  }

  return section;
};

const handleCommand = async (
  args: string,
  ctx: ExtensionCommandContext,
  engine: WorkflowEngine,
  tuner: ModelTuner,
  zellij: ZellijSupervisor,
  retro: RetroProposalApplier,
  retroArtifact: RetroProposalArtifact,
  projectConfig: ReturnType<typeof loadProjectConfig>,
  scheduler: HealthScheduler,
  getHealthChecks: () => HealthCheckResult[],
  startAutopilot: (
    workflowId: string,
    ctx?: ExtensionCommandContext,
  ) => { started: boolean; reason: string },
  stopAutopilot: (workflowId: string) => boolean,
  listAutopilot: () => string[],
): Promise<void> => {
  const [command, ...rest] = args.trim().split(/\s+/);

  if (!command || command === "status") {
    const states = engine.list();
    const panes = await zellij.listPanes();
    const recommendations = tuner.listRecommendations();
    ctx.ui.notify(`orchestra: ${states.length} workflows`, "info");
    ctx.ui.setWidget("orchestra", [
      ...buildOverviewLines({
        workflows: states,
        paneCount: panes.length,
        recommendationCount: recommendations.length,
      }),
      ...buildWorkflowLines(states),
      "--- actions ---",
      ...buildActionLines(states),
    ]);
    return;
  }

  if (command === "dashboard") {
    try {
      const section = parseDashboardSection(rest[0]);
      const page = Number(rest[1] ?? "1");
      const workflows = engine.list();
      const panes = await zellij.listPanes();
      const recommendations = tuner.listRecommendations();
      const experiments = tuner.listExperiments();
      const assignments = tuner.listAssignments();
      const lines = buildInteractiveDashboardLines({
        section,
        page: Number.isFinite(page) ? page : 1,
        pageSize: 8,
        workflows,
        paneRows: panes.map((pane) => ({
          id: pane.id,
          name: pane.name ?? "(unnamed)",
        })),
        recommendations,
        experiments,
        assignments,
        healthChecks: getHealthChecks(),
      });

      ctx.ui.setWidget("orchestra-dashboard", lines);
      ctx.ui.notify(`dashboard: ${section}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid input";
      ctx.ui.notify(`dashboard error: ${message}`, "error");
    }
    return;
  }

  if (command === "autopilot") {
    const workflowId = rest[0];
    if (!workflowId) {
      const running = listAutopilot();
      ctx.ui.setWidget(
        "orchestra-autopilot",
        running.length > 0
          ? ["running:", ...running.map((id) => `- ${id}`)]
          : ["no active autopilot workflows"],
      );
      ctx.ui.notify(
        running.length > 0
          ? `autopilot active: ${running.length}`
          : "autopilot idle",
        "info",
      );
      return;
    }

    if (rest[1] === "stop") {
      const stopped = stopAutopilot(workflowId);
      ctx.ui.notify(
        stopped
          ? `autopilot stopped: ${workflowId}`
          : `autopilot not running: ${workflowId}`,
        stopped ? "warning" : "info",
      );
      return;
    }

    const result = startAutopilot(workflowId, ctx);
    ctx.ui.notify(
      result.started
        ? `autopilot started: ${workflowId}`
        : `autopilot not started (${result.reason}): ${workflowId}`,
      result.started ? "info" : "warning",
    );
    return;
  }

  if (command === "help") {
    ctx.ui.setWidget("orchestra-help", buildCommandHelpLines());
    ctx.ui.notify("orchestra help updated", "info");
    return;
  }

  if (command === "project") {
    const currentProjectConfig = loadProjectConfig(process.cwd());
    ctx.ui.setWidget("orchestra-project", [
      `name=${currentProjectConfig.name}`,
      `flavor=${currentProjectConfig.flavor}`,
      `autonomy=${currentProjectConfig.autonomyLevel}`,
      `review_cadence=${currentProjectConfig.humanReviewCadence}`,
      `team_size=${currentProjectConfig.team.length}`,
    ]);
    ctx.ui.notify(`project: ${currentProjectConfig.name}`, "info");
    return;
  }

  if (command === "project-bootstrap") {
    const force = rest[0] === "force";
    const result = bootstrapProjectConfig(process.cwd(), { force });
    const currentProjectConfig = loadProjectConfig(process.cwd());
    ctx.ui.setWidget("orchestra-project-bootstrap", [
      `file=${result.file}`,
      `created=${result.created}`,
      `overwritten=${result.overwritten}`,
      `skipped=${result.skipped}`,
      ...(result.reason ? [`reason=${result.reason}`] : []),
      `name=${currentProjectConfig.name}`,
      `flavor=${currentProjectConfig.flavor}`,
    ]);
    ctx.ui.notify(
      result.skipped
        ? "project bootstrap skipped (already exists)"
        : "project bootstrap wrote .orchestra/project.ts",
      result.skipped ? "warning" : "info",
    );
    return;
  }

  if (command === "cutline") {
    const cutline = buildCutlineStatus();
    ctx.ui.setWidget("orchestra-cutline", [
      `branch=${cutline.branch}`,
      "--- ship now ---",
      ...cutline.shipNow,
      "--- deferred ---",
      ...cutline.deferred,
    ]);
    ctx.ui.notify("cutline status updated", "info");
    return;
  }

  if (command === "readiness") {
    const report = buildReadinessReport(buildCutlineStatus());
    ctx.ui.setWidget("orchestra-readiness", [
      `ready=${report.ready}`,
      `ship_now=${report.summary.shipNowCount}`,
      `deferred=${report.summary.deferredCount}`,
      `mutation_gate=${report.summary.mutationGate}`,
      `checks=${report.summary.requiredChecks.join(",")}`,
      ...(report.reasons.length > 0 ? report.reasons : ["no blocking reasons"]),
    ]);
    ctx.ui.notify(
      report.ready ? "branch readiness: go" : "branch readiness: no-go",
      report.ready ? "info" : "warning",
    );
    return;
  }

  if (command === "evidence-schema") {
    const workflowFilter = rest[0];
    const entries = collectEvidenceSchemas(engine.listDefinitions());
    const filtered = workflowFilter
      ? entries.filter((entry) => entry.workflow === workflowFilter)
      : entries;
    ctx.ui.notify(`evidence schemas: ${filtered.length}`, "info");
    ctx.ui.setWidget(
      "orchestra-evidence-schema",
      filtered.length > 0
        ? filtered.map(
            (entry) =>
              `${entry.workflow}/${entry.state}: ${
                Object.entries(entry.schema)
                  .map(([key, typeName]) => `${key}:${typeName}`)
                  .join(",") || "(none)"
              }`,
          )
        : ["No evidence schemas found"],
    );
    return;
  }

  if (command === "evidence-diagnostics") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify(
        "usage: /orchestra evidence-diagnostics <workflowId>",
        "error",
      );
      return;
    }

    const workflow = engine.get(workflowId);
    if (!workflow) {
      ctx.ui.notify(`unknown workflow: ${workflowId}`, "error");
      return;
    }

    const diagnostics = buildWorkflowEvidenceDiagnostics(workflow);
    ctx.ui.notify(
      `evidence diagnostics: failing=${diagnostics.filter((entry) => !entry.ok).length}`,
      diagnostics.some((entry) => !entry.ok) ? "warning" : "info",
    );
    ctx.ui.setWidget(
      "orchestra-evidence-diagnostics",
      diagnostics.length > 0
        ? diagnostics.flatMap((entry) =>
            entry.ok
              ? [`ok ${entry.state}`]
              : [
                  `warn ${entry.state}`,
                  ...entry.errors.map((error) => `  - ${error}`),
                ],
          )
        : ["No diagnostics available"],
    );
    return;
  }

  if (command === "start") {
    const workflow = rest[0];
    if (!workflow) {
      ctx.ui.notify("usage: /orchestra start <workflow> [jsonParams]", "error");
      return;
    }

    const paramsArg = rest.slice(1).join(" ");
    try {
      const state = engine.start(workflow, parseJsonParams(paramsArg));
      const dispatch = await engine.dispatchCurrentState(
        state.workflow_id as unknown as string,
      );
      ctx.ui.notify(
        `started ${workflow} (${state.workflow_id as string})`,
        "info",
      );
      ctx.ui.setWidget("orchestra-workflow", [
        ...buildWorkflowDetailLines(state),
        `dispatch=${dispatch.details}`,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      ctx.ui.notify(`failed to start workflow: ${message}`, "error");
    }
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

  if (command === "tuning") {
    const summaries = tuner.summarizeByRolePhase();
    const recommendations = tuner.listRecommendations();
    const experiments = tuner.listExperiments();
    const assignments = tuner.listAssignments();
    ctx.ui.notify(
      `tuning: ${summaries.length} groups, ${recommendations.length} recommendations, ${experiments.length} experiments`,
      "info",
    );
    ctx.ui.setWidget("orchestra-tuning", [
      ...buildTuningLines(recommendations),
      `experiments=${experiments.length}`,
      `pending=${experiments.filter((exp) => exp.status === "pending").length}`,
      `assignments=${assignments.length}`,
    ]);
    return;
  }

  if (command === "tuning-experiments") {
    const sub = rest[0] ?? "status";
    if (sub === "create-from-recommendations") {
      const created = tuner.createExperimentsFromRecommendations();
      ctx.ui.notify(`created ${created.length} experiments`, "info");
      ctx.ui.setWidget(
        "orchestra-tuning-experiments",
        created.length > 0
          ? created.map(
              (exp) =>
                `${exp.id}: ${exp.role}/${exp.phase} ${exp.baseline_model} -> ${exp.challenger_model}`,
            )
          : ["No experiments created"],
      );
      return;
    }

    if (sub === "run") {
      const result = tuner.runExperiments();
      ctx.ui.notify(
        `completed ${result.completed.length}, pending ${result.pending.length}`,
        result.pending.length > 0 ? "warning" : "info",
      );
      ctx.ui.setWidget("orchestra-tuning-experiments", [
        `completed=${result.completed.length}`,
        `pending=${result.pending.length}`,
        ...result.completed.map(
          (exp) =>
            `${exp.id}: ${exp.decision ?? "n/a"} (${exp.rationale ?? ""})`,
        ),
      ]);
      return;
    }

    const experiments = tuner.listExperiments();
    const assignments = tuner.listAssignments();
    ctx.ui.notify(`experiments: ${experiments.length}`, "info");
    ctx.ui.setWidget("orchestra-tuning-experiments", [
      `total=${experiments.length}`,
      `pending=${experiments.filter((exp) => exp.status === "pending").length}`,
      `assignments=${assignments.length}`,
      ...assignments.map(
        (assignment) =>
          `${assignment.role}/${assignment.phase}: ${assignment.model}`,
      ),
    ]);
    return;
  }

  if (command === "panes") {
    const panes = await zellij.listPanes();
    ctx.ui.notify(`panes: ${panes.length}`, "info");
    ctx.ui.setWidget(
      "orchestra-panes",
      panes.length > 0
        ? panes.map((pane) => `${pane.id}: ${pane.name ?? "(unnamed)"}`)
        : ["No zellij panes found"],
    );
    return;
  }

  if (command === "pane-recover") {
    const specsRaw = rest.join(" ").trim();
    if (!specsRaw) {
      ctx.ui.notify(
        "usage: /orchestra pane-recover <jsonArrayOfPaneSpecs>",
        "error",
      );
      return;
    }

    const specs = parsePaneSpecs(specsRaw);
    const outcome = await zellij.reconcilePanes(specs);
    ctx.ui.notify(
      `pane recovery: spawned=${outcome.spawned.length} missing=${outcome.missing.length}`,
      outcome.missing.length > 0 ? "warning" : "info",
    );
    ctx.ui.setWidget("orchestra-pane-recover", [
      `pane_count=${outcome.paneCount}`,
      `present=${outcome.present.length}`,
      `spawned=${outcome.spawned.length}`,
      `missing=${outcome.missing.length}`,
      ...outcome.spawned.map(
        (entry) => `spawned ${entry.name} -> ${entry.paneId ?? "unknown"}`,
      ),
      ...outcome.idChanges.map(
        (change) => `id-change ${change.name}: ${change.from} -> ${change.to}`,
      ),
      ...(outcome.missing.length > 0
        ? [`missing: ${outcome.missing.join(",")}`]
        : ["missing: none"]),
    ]);
    return;
  }

  if (command === "pane-focus") {
    const target = rest[0];
    if (!target) {
      ctx.ui.notify("usage: /orchestra pane-focus <paneId|paneName>", "error");
      return;
    }

    const ok = /^\d+$/.test(target)
      ? await zellij.focusPane(target)
      : await zellij.focusPaneByName(target);
    ctx.ui.notify(
      ok ? `focused ${target}` : `failed to focus ${target}`,
      ok ? "info" : "error",
    );
    return;
  }

  if (command === "pane-close") {
    const target = rest[0];
    if (!target) {
      ctx.ui.notify("usage: /orchestra pane-close <paneId|paneName>", "error");
      return;
    }

    const ok = /^\d+$/.test(target)
      ? await zellij.closePane(target)
      : await zellij.closePaneByName(target);
    ctx.ui.notify(
      ok ? `closed ${target}` : `failed to close ${target}`,
      ok ? "warning" : "error",
    );
    return;
  }

  if (command === "observe") {
    const workflows = engine.list();
    const panes = await zellij.listPanes();
    const recommendations = tuner.listRecommendations();
    const loaded = retro.loadLatestProposalsWithSource();
    ctx.ui.setWidget("orchestra-observability", [
      ...buildOverviewLines({
        workflows,
        paneCount: panes.length,
        recommendationCount: recommendations.length,
      }),
      `latest_retro_count=${loaded.proposals.length}`,
      `latest_retro_source=${loaded.source ?? "none"}`,
      ...buildWorkflowLines(workflows),
      "--- actions ---",
      ...buildActionLines(workflows),
      "--- tuning ---",
      ...buildTuningLines(recommendations),
    ]);
    ctx.ui.notify("observability widget updated", "info");
    return;
  }

  if (command === "actions") {
    const workflows = engine.list();
    ctx.ui.setWidget("orchestra-actions", buildActionLines(workflows));
    ctx.ui.notify("next actions updated", "info");
    return;
  }

  if (command === "health") {
    const results = await scheduler.runOnce();
    const failing = results.filter((result) => !result.ok).length;
    const schedulerState = scheduler.getState();
    ctx.ui.setWidget("orchestra-health", [
      `failure_streak=${schedulerState.failureStreak}`,
      `threshold=${schedulerState.escalationThreshold}`,
      ...results.map(
        (result) =>
          `${result.ok ? "ok" : "warn"} ${result.name}: ${result.message}`,
      ),
      ...(schedulerState.escalation
        ? [`escalated_at=${schedulerState.escalation.at}`]
        : []),
    ]);
    ctx.ui.notify(
      failing > 0
        ? `health checks: ${failing} warning(s)`
        : "health checks: all good",
      failing > 0 ? "warning" : "info",
    );
    return;
  }

  if (command === "workflow") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify("usage: /orchestra workflow <workflowId>", "error");
      return;
    }

    const workflow = engine.get(workflowId);
    ctx.ui.setWidget("orchestra-workflow", buildWorkflowDetailLines(workflow));
    ctx.ui.notify(
      workflow
        ? `workflow ${workflowId} loaded`
        : `workflow ${workflowId} not found`,
      workflow ? "info" : "error",
    );
    return;
  }

  if (command === "dispatch") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify("usage: /orchestra dispatch <workflowId>", "error");
      return;
    }

    const result = await engine.dispatchCurrentState(workflowId);
    ctx.ui.notify(result.details, result.dispatched ? "info" : "warning");
    return;
  }

  if (command === "retro-show") {
    const workflowId = rest[0];
    const loaded = retro.loadLatestProposalsWithSource(workflowId);
    ctx.ui.notify(
      `retro proposals: ${loaded.proposals.length}${loaded.source ? ` from ${loaded.source}` : ""}`,
      "info",
    );
    ctx.ui.setWidget(
      "orchestra-retro",
      loaded.proposals.length > 0
        ? loaded.proposals.map(
            (proposal) =>
              `${proposal.id}: ${proposal.action} ${proposal.target}`,
          )
        : ["No retro proposals found"],
    );
    return;
  }

  if (command === "retro-materialize") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify(
        "usage: /orchestra retro-materialize <workflowId> [apply]",
        "error",
      );
      return;
    }

    const workflow = engine.get(workflowId);
    if (!workflow) {
      ctx.ui.notify(`workflow ${workflowId} not found`, "error");
      return;
    }

    const dryRun = !rest.includes("apply");
    const materialized = retroArtifact.materializeFromWorkflow(
      workflow,
      (filePath) => retro.loadProposals(filePath),
      dryRun,
    );
    ctx.ui.notify(
      `retro materialized: ${materialized.proposalCount} proposals (${dryRun ? "dry-run" : "written"})`,
      dryRun ? "warning" : "info",
    );
    ctx.ui.setWidget("orchestra-retro", [
      `source=${materialized.source ?? "none"}`,
      `target=${materialized.target}`,
      `proposal_count=${materialized.proposalCount}`,
    ]);
    return;
  }

  if (command === "retro-pipeline") {
    const workflowId = rest[0];
    if (!workflowId) {
      ctx.ui.notify(
        "usage: /orchestra retro-pipeline <workflowId> [apply]",
        "error",
      );
      return;
    }

    const workflow = engine.get(workflowId);
    if (!workflow) {
      ctx.ui.notify(`workflow ${workflowId} not found`, "error");
      return;
    }

    const apply = rest.includes("apply");
    const materialized = retroArtifact.materializeFromWorkflow(
      workflow,
      (filePath) => retro.loadProposals(filePath),
      !apply,
    );
    const results = retro.applyProposals(materialized.proposals, !apply);
    const applied = results.filter((result) => result.applied).length;
    ctx.ui.notify(
      `retro pipeline: ${applied}/${results.length} (${apply ? "applied" : "dry-run"})`,
      apply ? "info" : "warning",
    );
    ctx.ui.setWidget("orchestra-retro", [
      `source=${materialized.source ?? "none"}`,
      `target=${materialized.target}`,
      ...buildRetroApplyLines(results),
    ]);
    return;
  }

  if (command === "retro-apply") {
    const firstArg = rest[0];
    const dryRun = !rest.includes("apply");
    const workflowId =
      firstArg && !firstArg.endsWith(".json") ? firstArg : undefined;
    const proposals = firstArg?.endsWith(".json")
      ? retro.loadProposals(firstArg)
      : retro.loadLatestProposals(workflowId);
    const results = retro.applyProposals(proposals, dryRun);
    const applied = results.filter((result) => result.applied).length;
    ctx.ui.notify(
      `retro proposals processed: ${applied}/${results.length} (${dryRun ? "dry-run" : "applied"})`,
      dryRun ? "warning" : "info",
    );
    ctx.ui.setWidget("orchestra-retro", buildRetroApplyLines(results));
    return;
  }

  ctx.ui.notify(`unknown orchestra command: ${command}`, "error");
};
