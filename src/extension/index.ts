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
  buildActionLines,
  buildCommandHelpLines,
  buildOverviewLines,
  buildRetroApplyLines,
  buildTuningLines,
  buildWorkflowDetailLines,
  buildWorkflowLines,
} from "../observability/dashboard";
import { loadProjectConfig } from "../project/config";
import { buildCutlineStatus } from "../project/cutline";
import { buildReadinessReport } from "../project/readiness";
import { RetroProposalApplier } from "../retro/proposal-applier";
import { RetroProposalArtifact } from "../retro/proposal-artifact";
import { ZellijSupervisor } from "../runtime/zellij-supervisor";
import { ModelTuner } from "../tuning/model-tuner";

const asToolResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export default function (pi: ExtensionAPI): void {
  const root = path.join(process.cwd(), ".orchestra");
  const store = new StateStore(root);
  store.ensure();

  const projectConfig = loadProjectConfig(process.cwd());
  const engine = new WorkflowEngine(pi, process.cwd(), store);
  const tuner = new ModelTuner(path.join(root, "tuning"));
  const retro = new RetroProposalApplier(process.cwd());
  const retroArtifact = new RetroProposalArtifact(process.cwd());
  const zellij = new ZellijSupervisor(pi);
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
      return asToolResult(projectConfig);
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
      });
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

const handleCommand = async (
  args: string,
  ctx: ExtensionCommandContext,
  engine: WorkflowEngine,
  tuner: ModelTuner,
  zellij: ZellijSupervisor,
  retro: RetroProposalApplier,
  retroArtifact: RetroProposalArtifact,
  projectConfig: ReturnType<typeof loadProjectConfig>,
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

  if (command === "help") {
    ctx.ui.setWidget("orchestra-help", buildCommandHelpLines());
    ctx.ui.notify("orchestra help updated", "info");
    return;
  }

  if (command === "project") {
    ctx.ui.setWidget("orchestra-project", [
      `name=${projectConfig.name}`,
      `flavor=${projectConfig.flavor}`,
      `autonomy=${projectConfig.autonomyLevel}`,
      `review_cadence=${projectConfig.humanReviewCadence}`,
      `team_size=${projectConfig.team.length}`,
    ]);
    ctx.ui.notify(`project: ${projectConfig.name}`, "info");
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
    ctx.ui.notify(
      `tuning: ${summaries.length} groups, ${recommendations.length} recommendations`,
      "info",
    );
    ctx.ui.setWidget("orchestra-tuning", buildTuningLines(recommendations));
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
