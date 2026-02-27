# Orchestra — Deterministic Multi-Agent SDLC for Pi

## Vision

A lights-out software factory where a human says "build me a bread logging
app" and gets a production-quality, event-sourced, TDD'd, reviewed, tested,
design-system-compliant application out the other end — with the option to be
as hands-on or hands-off as they choose at any point.

The bread_log project proves this is nearly achievable today: 32 vertical
slices shipped (PRs #67–#99), full pipeline with quality gates, 10-member
expert team, event modeling, domain-driven design, TDD pairing, mutation
testing, three-stage code review. All orchestrated by prompts.

The problem is that "orchestrated by prompts" means "orchestrated by hope."

## Problem Statement

We need a pi extension that provides **deterministic, structurally-enforced
multi-agent workflows** — replacing prompt-based coordination with a state
machine that agents cannot deviate from.

### Evidence: What Goes Wrong (from 119MB of bread_log session logs)

**21 context compactions in a single session.** Each one resets the
coordinator's behavioral corrections, accumulated process knowledge, and
inter-agent message history. The coordinator resumes with a lossy summary
and immediately reverts to bad habits it was corrected on 5 compactions ago.

**"no, have our fucking agent team do it"** — User message #3 in the 119MB
session. The pipeline controller's very first action was to spawn a generic
Task agent instead of using the named ensemble team. This happened despite:
the pipeline skill saying "NEVER spawn anonymous agents", the coordinator
instructions saying "ALWAYS dispatch to named team members", and CLAUDE.md
saying "NEVER spawn generic unnamed agents." Three levels of "MUST NOT"
in prompts. The LLM did it anyway.

**"no, that's not what I meant. I said use the team agents with SendMessage;
you were doing it with generic tasks"** — After being corrected once, the
controller reverted to generic agents on the very next compaction. The
user had to correct this multiple times across the session.

**"Don't be a liar; this is what you did earlier"** — The controller denied
having used generic Task agents. The user had to paste the evidence of the
violation back at the controller.

**"Not a single bit of it seems to be using the design system. FAIL."** —
32 slices shipped through the pipeline with TDD, three-stage review, and
mutation testing. Every quality gate passed. And the entire frontend was
unstyled because none of the review agents checked design system compliance
and the pipeline had no structural gate for it. The prompt said "check
design tokens" but no one did, and no gate enforced it.

**266 subagents spawned** in the factory session. Many were redundant
respawns after compaction, duplicates from confused coordination, or
generic Task agents that should have been named team members.

**Idle notification spam**: Every time an agent went idle (because it was
thinking, or waiting for a peer), the coordinator received an idle
notification and had to be prompted not to act on it. The session logs show
dozens of "Agent X is idle — expected, waiting" messages where the
coordinator correctly did nothing, interspersed with cases where it
panicked and sent unnecessary status checks.

**RALPH_PROMPT.md** — The user's attempt to define a deterministic pipeline
as a prompt. 150 lines of explicit step-by-step instructions (B1 through
B13) with "Hard Rules" section. The LLM followed it for a while, then
drifted. The user had to create the Ralph Loop skill to force re-reading
the prompt every iteration. Even that wasn't enough — after compaction, the
controller forgot the Ralph prompt existed and had to be reminded to read
RALPH_PROMPT.md.

### Root Causes (not symptoms)

1. **Prompts are advisory, not structural.** "MUST NOT write code" is a
   suggestion to an LLM. It works 90% of the time. Over 32 slices and 21
   compactions, that 10% failure rate compounds into guaranteed violations.

2. **Context compaction is lossy and unpredictable.** The compaction summary
   captures "what happened" but not "what behavioral corrections were made."
   An agent corrected 6 times for the same violation will revert after
   compaction because the corrections aren't in the summary.

3. **No delivery guarantees.** Claude Code's SendMessage blocks the sender
   if the recipient is busy. The sender interprets the block as "message
   lost" and resends. When the recipient finishes, it gets 5 copies of the
   same message, responds to all of them, and wastes tokens.

4. **The coordinator is an LLM.** It suffers from the same attention decay,
   instruction-following failures, and context sensitivity as any other LLM.
   Making it "the brain" of the operation means every coordination decision
   is probabilistic.

5. **No independent verification.** When a RED agent says "tests fail," the
   pipeline trusts the agent's claim. When a reviewer says "APPROVED," the
   pipeline trusts the verdict. No mechanical check verifies these claims.

## Design Goals

1. **The state machine is the coordinator.** Not an LLM. A deterministic
   program that reads state, checks gates, and dispatches work. It cannot
   be confused, cannot forget instructions, and cannot be sweet-talked into
   skipping a step.

2. **Guaranteed-delivery message bus.** A lightweight local server inside
   the conductor extension. Push-based delivery, non-blocking sends, durable
   via write-ahead log. Agents interact via simple HTTP calls to a Unix
   domain socket — no filesystem polling, no race conditions.

3. **Structural role enforcement.** A RED agent's `edit` tool is scoped to
   test files. Not "please only edit test files" — the tool call is blocked
   if the path doesn't match. The LLM can try; it will fail.

4. **Independent gate verification.** When a RED agent submits "tests fail"
   as evidence, the conductor runs the tests itself and verifies. When a
   reviewer submits "APPROVED," the conductor checks that the review file
   exists and has the required structure. Trust but verify — mechanically.

5. **Compaction-proof.** All workflow state lives on the filesystem, not in
   any agent's context. An agent can be killed, compacted, or replaced
   mid-phase. The conductor re-dispatches from `state.json` with full
   evidence context. No information lives only in an LLM's memory.

6. **Zellij-native.** Agents in panes. Human can observe, interact, or
   ignore. The factory runs whether the human is watching or not.

7. **Composable workflows.** TDD ping-pong, consensus review, and the full
   pipeline are all workflow definitions. New workflows (exploratory QA,
   design system audit, event modeling session) can be added without changing
   the extension code.

8. **Hands-on to hands-off spectrum.** At any point, the human can:
   - Watch silently (full autonomy, lights-out)
   - Focus a pane and chat with an agent directly
   - Pause the workflow, make manual changes, resume
   - Override a gate result
   - Inject a new workflow step
   - Take over as an agent (human-in-the-loop at any point)

9. **Adaptive model selection.** The system collects structured performance
   data per (model, role, phase) tuple and continuously tunes model
   assignments based on quality signals, cost, and latency. Starts with
   sensible defaults, converges toward optimal allocation through real-world
   results evaluated by both humans and AI.

## Technical Decisions

### Implementation Language & Stack

Orchestra is a TypeScript project running on Node.js (≥22).

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript (strict mode) | Pi extensions are TypeScript, loaded via jiti — no compilation step |
| Runtime | Node.js ≥22 | Pi itself runs on Node.js; we're in-process |
| Package manager | npm | Matches pi's ecosystem; no reason to diverge |
| Test runner | Vitest | Fast, native TypeScript, good assertion library, watch mode |
| Mutation testing | Stryker | Only serious mutation testing tool for TypeScript |
| Linter | Biome | Fast, opinionated, replaces ESLint + Prettier |
| Dev environment | Nix flake | Consistent with user's workflow (bread_log, stochastic_macro both use flakes) |

### Project Setup

The repository `jwilger/pi-orchestra` ships as a pi package. The
`package.json` declares the extension entry point:

```json
{
  "name": "pi-orchestra",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "dependencies": {},
  "devDependencies": {
    "vitest": "...",
    "@stryker-mutator/core": "...",
    "@stryker-mutator/vitest-runner": "...",
    "@biomejs/biome": "..."
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:mutate": "stryker run",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  }
}
```

Install for development: `pi -e ./src/extension/index.ts`
Install from git: `pi install git:github.com/jwilger/pi-orchestra`

### Nix Flake

```nix
{
  description = "pi-orchestra development environment";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            git
            git-spice
            zellij
            jq
          ];
          shellHook = ''
            echo "pi-orchestra development environment loaded"
          '';
        };
      }
    );
}
```

## Pi Extension API Reference (for implementors)

This section captures the pi APIs that Orchestra depends on. A fresh
session implementing this plan should not need to read pi's documentation
separately — everything needed is here.

### Extension Loading

Extensions are TypeScript files loaded via [jiti](https://github.com/unjs/jiti)
(no compilation needed). They export a default function receiving
`ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, subscribe to events, register commands
}
```

**Auto-discovery locations:**
- Global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`
- Project: `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts`
- Explicit: `pi -e ./path/to/extension.ts`
- Package: declared in `package.json` under `"pi": { "extensions": [...] }`

### Available Imports

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, events, `isToolCallEventType` |
| `@sinclair/typebox` | `Type.Object`, `Type.String`, etc. for tool parameter schemas |
| `@mariozechner/pi-ai` | `StringEnum` (required for Google-compatible enums) |
| `@mariozechner/pi-tui` | `Text`, `Container`, `Markdown`, `Spacer` for custom rendering |

These are pi's bundled packages — list them in `peerDependencies` with `"*"`.
Node.js built-ins (`node:fs`, `node:http`, `node:path`, etc.) are available.
npm dependencies work if declared in `package.json` and installed.

### Registering Custom Tools

Tools are registered via `pi.registerTool()` and become callable by the LLM:

```typescript
import { Type } from "@sinclair/typebox";

pi.registerTool({
  name: "orchestra_start",
  label: "Orchestra Start",
  description: "Start a workflow instance",
  parameters: Type.Object({
    workflow: Type.String({ description: "Workflow definition name" }),
    params: Type.Optional(Type.Record(Type.String(), Type.Any())),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal: AbortSignal for cancellation
    // onUpdate: callback for streaming partial results
    // ctx: ExtensionContext with ctx.ui, ctx.cwd, ctx.sessionManager
    return {
      content: [{ type: "text", text: "Workflow started" }],
      details: { workflowId: "..." },
    };
  },
  // Optional: custom TUI rendering
  renderCall(args, theme) { ... },
  renderResult(result, { expanded, isPartial }, theme) { ... },
});
```

**Important:** Use `StringEnum` from `@mariozechner/pi-ai` for string enums
(not `Type.Union`/`Type.Literal` — Google's API rejects those).

### Intercepting Tool Calls (Structural Enforcement)

The `tool_call` event fires before any tool executes. Returning
`{ block: true, reason: "..." }` prevents execution. This is how Orchestra
enforces file-scope restrictions:

```typescript
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // isToolCallEventType narrows the event type and provides typed input
  if (isToolCallEventType("edit", event)) {
    // event.input is { path: string, oldText: string, newText: string }
    if (!isPathAllowed(event.input.path)) {
      return { block: true, reason: `BLOCKED: cannot write to ${event.input.path}` };
    }
  }
  if (isToolCallEventType("write", event)) {
    // event.input is { path: string, content: string }
    if (!isPathAllowed(event.input.path)) {
      return { block: true, reason: `BLOCKED: cannot write to ${event.input.path}` };
    }
  }
});
```

**Tool names that accept paths:** `edit` (path), `write` (path), `read`
(path), `bash` (command — may need path extraction from command string).

### Registering Commands

Commands are `/slash` commands the human types directly:

```typescript
pi.registerCommand("orchestra", {
  description: "Orchestra workflow management",
  handler: async (args, ctx) => {
    // ctx is ExtensionCommandContext (extends ExtensionContext)
    // Has additional methods: ctx.waitForIdle(), ctx.newSession(), etc.
    ctx.ui.notify(`Orchestra: ${args}`, "info");
  },
});
```

### Injecting Messages

Send messages into the LLM's context (steering, follow-ups):

```typescript
// Custom message (non-user) — for notifications, status updates
pi.sendMessage({
  customType: "orchestra",
  content: "Workflow advanced to GREEN phase",
  display: true,
}, { deliverAs: "steer", triggerTurn: true });

// User message — triggers a full agent turn as if the human typed it
pi.sendUserMessage("The RED phase is complete. Here is the evidence: ...", {
  deliverAs: "followUp",
});
```

**Delivery modes:**
- `"steer"` — interrupts current streaming, delivered after current tool
- `"followUp"` — waits for agent to finish, then delivered
- `"nextTurn"` — queued for next user prompt

### Event Lifecycle (relevant events)

| Event | When | Use in Orchestra |
|-------|------|-----------------|
| `session_start` | Pi session loads | Initialize conductor, start bus server |
| `session_shutdown` | Pi exits | Stop bus server, flush WAL, clean up panes |
| `tool_call` | Before any tool executes | **Structural enforcement** — block out-of-scope writes |
| `tool_result` | After tool executes | Collect metrics (tokens, cost) from tool results |
| `before_agent_start` | Before LLM processes prompt | Inject workflow context into system prompt |
| `agent_end` | LLM finishes responding | Collect per-turn metrics |
| `session_before_compact` | Before compaction | Custom compaction that preserves workflow state |
| `message_update` | Streaming LLM output | Live agent output forwarding to conductor UI |

### Spawning Agent Processes

Orchestra spawns agents as separate `pi` processes in zellij panes. Two
approaches are available:

**Approach 1: CLI spawn (simpler, used for Phase 1)**

```bash
# Spawn pi in a zellij pane with:
# --mode json    → structured JSON events on stdout (for monitoring)
# -p             → print mode (non-interactive, process prompt and exit)
# --no-session   → ephemeral, no session persistence
# -e <ext>       → load the scope extension (tool restrictions + bus tools)
# --append-system-prompt <file>  → persona + role instructions
# --model <id>   → model assignment from tuner
# --tools <list> → restrict available built-in tools

zellij action new-pane --name "agent-kent" --cwd /project/dir -- \
  pi --mode json -p --no-session \
  --tools read,bash,edit,write \
  -e .orchestra/runtime/agent-kent/scope.ts \
  --model claude-haiku-4 \
  --append-system-prompt .orchestra/runtime/agent-kent/prompt.md \
  "$(cat .orchestra/runtime/agent-kent/initial-task.md)"
```

**JSON mode output** streams events to stdout, one JSON object per line:
```json
{"type": "message_update", "message": {...}, "assistantMessageEvent": {"type": "text_delta", "delta": "..."}}
{"type": "tool_execution_start", "toolCallId": "...", "toolName": "edit", "args": {...}}
{"type": "tool_execution_end", "toolCallId": "...", "toolName": "edit", "result": {...}, "isError": false}
{"type": "agent_end", "messages": [...]}
```

The conductor can monitor agent output by reading the zellij pane's stdout
(or by having agents report via the bus). Key events:
- `agent_end` → agent finished its task, check for evidence submission
- `tool_execution_end` → track what files the agent touched
- `message_update` with `assistantMessageEvent.type === "done"` → final
  response, check `reason` for "stop" vs "error"

**Approach 2: SDK spawn (richer, for later phases)**

For tighter integration, spawn agents using pi's SDK directly from the
conductor's Node.js process:

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  model: selectedModel,
  tools: createCodingTools(projectCwd),
  customTools: [sendMessageTool, checkInboxTool, submitEvidenceTool],
  // ...
});

session.subscribe((event) => {
  // Monitor agent events in-process
});

await session.prompt(initialTask);
```

This eliminates the need for JSON stdout parsing but requires managing the
zellij pane separately (for human visibility). Phase 1 uses CLI spawn for
simplicity; later phases may migrate to SDK spawn for better control.

**`--append-system-prompt`** accepts a file path. The file contents are
appended to pi's default system prompt. Orchestra generates this file per
agent, combining: persona markdown + role definition + workflow context +
current evidence.

### Persistent State in Sessions

Extensions can persist state that survives restarts:

```typescript
// Save state (does NOT go to LLM context)
pi.appendEntry("orchestra-state", { workflows: [...], metrics: [...] });

// Restore on session load
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "orchestra-state") {
      restoreState(entry.data);
    }
  }
});
```

### UI Capabilities

```typescript
// Status bar (persistent footer text)
ctx.ui.setStatus("orchestra", "TDD Slice 3: GREEN phase (2/3 retries)");

// Widget (persistent block above or below editor)
ctx.ui.setWidget("orchestra", [
  "━━━ Orchestra: tdd-slice-auth ━━━",
  "Phase: GREEN  Agent: greg  Retry: 2/3",
  "Evidence: tests passing (verified)",
]);

// Notifications (non-blocking toast)
ctx.ui.notify("Gate passed: advancing to DOMAIN_REVIEW", "success");

// Dialogs (blocking, for human decisions)
const choice = await ctx.ui.select("Escalation", ["Retry", "Skip", "Abort"]);
const approved = await ctx.ui.confirm("Approve?", "Model change: Haiku → Sonnet for RED");
```

### Shell Command Execution

```typescript
// From the extension (not the LLM)
const result = await pi.exec("cargo", ["nextest", "run"], {
  signal: abortSignal,
  timeout: 60000,
});
// result.stdout, result.stderr, result.code, result.killed
```

This is how the conductor runs independent verification commands (test
suites, mutation tools, linters) without involving any LLM.

## Zellij CLI Reference (for implementors)

Orchestra uses zellij for agent pane management. Key commands:

### Spawning Panes

```bash
# Open a new pane running a command
zellij action new-pane \
  --name "agent-kent" \       # Pane display name
  --direction down \          # down | right (or omit for auto-placement)
  --cwd /project/dir \        # Working directory
  --close-on-exit \           # Auto-close when command exits
  -- pi --mode json -p ...    # Command to run

# Floating pane (for status/monitoring)
zellij action new-pane --floating --name "orchestra-status" -- ...

# Stacked pane
zellij action new-pane --stacked --name "agent-kent" -- ...
```

### Pane Management

```bash
# Close the currently focused pane
zellij action close-pane

# Move focus
zellij action move-focus right   # right | left | up | down
zellij action focus-next-pane
zellij action focus-previous-pane

# Resize
zellij action resize increase right

# Toggle fullscreen for focused pane
zellij action toggle-fullscreen

# Dump current layout (for debugging)
zellij action dump-layout

# Write to the focused pane's terminal (for sending input)
zellij action write-chars "some text"
```

### Session Management

```bash
# Start a named zellij session
zellij -s orchestra-session

# Start with a layout file
zellij -s orchestra-session -l ./layouts/tdd.kdl

# Attach to existing session
zellij attach orchestra-session
```

### Layout Files (KDL format)

```kdl
layout {
  pane name="conductor" size="40%" {
    command "pi"
    args "-e" ".orchestra/runtime/conductor/scope.ts"
  }
  pane split_direction="vertical" size="60%" {
    pane name="agent-ping" size="50%"
    pane name="agent-pong" size="50%"
  }
  pane name="agent-reviewer" size="30%"
}
```

**Limitations:**
- `zellij action close-pane` closes the *focused* pane — there's no
  `close-pane --name <name>`. The conductor must focus a pane before
  closing it, or track pane IDs.
- Pane IDs are not directly exposed via `zellij action`. The conductor may
  need to parse `zellij action dump-layout` output to find pane IDs.
- No programmatic API — all interaction is via CLI `zellij action` commands
  or layout files.

## Unix Domain Socket HTTP in Node.js (for implementors)

The message bus server listens on a Unix domain socket. Node.js's built-in
`node:http` module supports this natively:

### Server Side (inside conductor extension)

```typescript
import http from "node:http";
import fs from "node:fs";

const SOCKET_PATH = ".orchestra/bus.sock";

// Clean up stale socket
if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

const server = http.createServer((req, res) => {
  // Route handling...
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    // Process message...
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "msg-uuid", status: "delivered" }));
  });
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600); // Restrict access
});

// Cleanup on shutdown
pi.on("session_shutdown", async () => {
  server.close();
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
});
```

### Client Side (agent tools calling the bus)

```typescript
import http from "node:http";

function busRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: ".orchestra/bus.sock",
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Usage in agent tools:
await busRequest("POST", "/messages", { from: "agent-kent", to: "agent-greg", ... });
const inbox = await busRequest("GET", `/inbox/agent-kent`);
```

### Long-Polling for Inbox

```typescript
// Server side: hold the response open until a message arrives or timeout
app.get("/inbox/:agentId", (req, res) => {
  const messages = getMessages(req.params.agentId);
  if (messages.length > 0) {
    res.json(messages);
  } else {
    // Hold connection open, deliver when message arrives
    const timeout = setTimeout(() => res.json([]), 30000);
    onMessageForAgent(req.params.agentId, (msg) => {
      clearTimeout(timeout);
      res.json([msg]);
    });
  }
});
```

**Note:** `fetch()` with Unix domain sockets is NOT natively supported in
Node.js. Use `node:http` with `socketPath` option as shown above. The
`undici` library (Node.js's internal fetch implementation) does support
Unix sockets via its `Agent` class, but `node:http` is simpler and has
zero dependencies.

## Reference Material Locations

These paths point to existing work that informs Orchestra's design. A fresh
session should consult these when implementing specific components.

### Pi Documentation (authoritative API reference)

| Document | Path | Relevant For |
|----------|------|-------------|
| Extension API | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` | All extension code |
| SDK | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md` | Agent spawning (Approach 2) |
| RPC protocol | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md` | Agent communication protocol |
| Packages | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md` | Distribution, package.json manifest |
| TUI components | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md` | Conductor UI widgets |
| Subagent example | `/home/jwilger/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent/` | Reference for spawning pi processes, JSON mode parsing, abort handling |

### Existing Skills Library (domain knowledge for agent definitions)

These skills contain the deep domain knowledge that should inform agent
definitions and workflow structure. Read these when writing agent personas
and workflow gate logic.

| Skill | Path | Informs |
|-------|------|---------|
| TDD | `~/.agents/skills/tdd/SKILL.md` | RED/GREEN agent definitions, phase boundaries, 5-step cycle, outside-in |
| TDD Orchestrator | `~/.agents/skills/tdd/references/orchestrator.md` | How TDD pairs coordinate, handoff schema |
| TDD Ping-Pong | `~/.agents/skills/tdd/references/ping-pong-pairing.md` | Specific RED↔GREEN handoff protocol |
| Pipeline | `~/.agents/skills/pipeline/SKILL.md` | Slice queue, gate definitions, rework protocol |
| Gate Definitions | `~/.agents/skills/pipeline/references/gate-definitions.md` | What each gate checks, evidence schemas |
| Slice Queue | `~/.agents/skills/pipeline/references/slice-queue.md` | Queue format, prioritization, dependencies |
| Rework Protocol | `~/.agents/skills/pipeline/references/rework-protocol.md` | How failed gates route back to earlier phases |
| Agent Coordination | `~/.agents/skills/agent-coordination/SKILL.md` | Anti-patterns to avoid (informed the problem statement) |
| Anti-patterns | `~/.agents/skills/agent-coordination/references/anti-patterns.md` | Specific coordination failures Orchestra must prevent |
| Ensemble Team | `~/.agents/skills/ensemble-team/SKILL.md` | Team formation, consensus decisions, retrospectives |
| Code Review | `~/.agents/skills/code-review/SKILL.md` (if exists) | Three-stage review protocol |
| Error Recovery | `~/.agents/skills/error-recovery/SKILL.md` | Retry strategies, escalation patterns |
| Memory Protocol | `~/.agents/skills/memory-protocol/SKILL.md` | Why filesystem state > LLM memory |

### bread_log Project (production reference)

The bread_log project is the real-world system that exposed all the problems
Orchestra solves. It's the reference for "what working looks like" and
"what breaks."

| Artifact | Path | Relevance |
|----------|------|-----------|
| Team profiles | `~/projects/bread_log/.team/` | Reference personas (kent-beck.md, scott-wlaschin.md, etc.) |
| Coordinator instructions | `~/projects/bread_log/.team/coordinator-instructions.md` | What the prompt-based coordinator tried to enforce |
| AGENTS.md | `~/projects/bread_log/AGENTS.md` | Project conventions that should become workflow structure |
| CLAUDE.md | `~/projects/bread_log/CLAUDE.md` | Rules the LLM ignored (evidence for structural enforcement) |
| Factory audit trail | `~/projects/bread_log/.factory/` | What the pipeline actually produced per slice |
| Session with most evidence | `~/.claude/projects/-home-jwilger-projects-bread-log/61053e31-a2e7-4142-ab95-bf885afd81bd.jsonl` | 119MB, 21 compactions, 266 subagents — the failure data |
| RALPH_PROMPT.md | Recoverable via `git show ea1b578:RALPH_PROMPT.md` in bread_log repo | Deterministic pipeline as a prompt (the approach that failed) |

## Architecture

### Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        Zellij Session                        │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            Conductor (pi extension)                  │    │
│  │                                                      │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │    │
│  │  │  Workflow    │  │  Message Bus │  │  Model    │  │    │
│  │  │  Engine      │  │  Server      │  │  Tuner    │  │    │
│  │  │ (determin-  │  │ (Unix socket │  │ (learns   │  │    │
│  │  │  istic TS)  │  │  HTTP API)   │  │  from     │  │    │
│  │  │             │  │              │  │  metrics)  │  │    │
│  │  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  │    │
│  │         │                │                 │         │    │
│  │         └────────────────┼─────────────────┘         │    │
│  │                          │ .orchestra/bus.sock        │    │
│  └──────────────────────────┼───────────────────────────┘    │
│                             │                                │
│            ┌────────────────┼────────────────┐               │
│            │                │                │               │
│     ┌──────┴─────┐  ┌──────┴─────┐  ┌──────┴─────┐        │
│     │ Agent: Ping│  │ Agent: Pong│  │ Agent: Rev │  ...    │
│     │ (pi + scope│  │ (pi + scope│  │ (pi + scope│        │
│     │  extension)│  │  extension)│  │  extension)│        │
│     │            │  │            │  │            │        │
│     │ HTTP tools:│  │ HTTP tools:│  │ HTTP tools:│        │
│     │ send_msg   │  │ send_msg   │  │ send_msg   │        │
│     │ check_inbox│  │ check_inbox│  │ check_inbox│        │
│     │ submit_evid│  │ submit_evid│  │ submit_evid│        │
│     └────────────┘  └────────────┘  └────────────┘        │
│                                                              │
│  Persisted to disk:                                          │
│  .orchestra/                                                 │
│    bus.wal               (message WAL for crash recovery)    │
│    workflows/<id>/                                           │
│      state.json          (current state + full history)      │
│      evidence/           (gate evidence per phase)           │
│    tuning/               (model performance data)            │
│    workflows.d/          (TypeScript workflow definitions)    │
│    agents.d/             (agent definition markdown)          │
│    runtime/<agent-id>/   (generated scope extensions)        │
└──────────────────────────────────────────────────────────────┘
```

### Component 1: The Conductor (pi extension + deterministic engine)

The conductor is a pi extension running in the human's pi session. The
critical distinction: **the conductor's workflow engine is deterministic
TypeScript code, not LLM reasoning.** The LLM in the human's session can
invoke orchestra tools, but the workflow transitions are hard-coded logic.

**Custom tools registered by the extension:**
- `orchestra_start <workflow> [params]` — Instantiate a workflow
- `orchestra_status` — Show all workflows, agents, phases, evidence
- `orchestra_send <agent> <message>` — Human-to-agent message
- `orchestra_pause / orchestra_resume` — Pause/resume a workflow
- `orchestra_kill <agent>` — Terminate an agent pane
- `orchestra_override <workflow> <gate> <result>` — Human overrides a gate
- `orchestra_inject <workflow> <state>` — Insert an ad-hoc state

**The engine is event-driven (not polling):**

The conductor runs an HTTP server on a Unix domain socket. Evidence
submissions, heartbeats, and messages arrive as HTTP requests, triggering
the engine immediately — no polling interval, no wasted wall-clock time.

```
on POST /evidence/:workflow-id:
  validate evidence against gate schema
  if gate has independent_verification:
    run verification commands (test suite, file checks, etc.)
  if gate passes:
    advance to next state per workflow definition
    dispatch work to assigned agent (push message via bus)
    persist state.json to disk
    record metrics (cost, tokens, latency, retries)
  if gate fails:
    increment retry counter
    if retries exhausted: transition to ESCALATE
    else: re-dispatch with failure feedback

on heartbeat timeout (agent missed N heartbeats):
  mark agent as dead
  check if re-spawn is appropriate
  move pending messages to dead-letter if unrecoverable

on POST /messages (agent-to-agent):
  route message to recipient's inbox
  if recipient has pending long-poll: deliver immediately
  persist to WAL
```

This is **not an LLM call.** It's a Node.js HTTP server handling requests
with deterministic TypeScript logic. It reads JSON, checks conditions,
writes JSON. No probabilistic reasoning anywhere in the loop.

### Component 2: Message Bus (Local Server)

A lightweight HTTP server running inside the conductor extension, listening
on a Unix domain socket at `.orchestra/bus.sock`. Push-based delivery,
in-memory queue with write-ahead log for crash recovery.

**Why a server, not filesystem:**
- **No polling.** Filesystem bus requires 1-2 second poll intervals. Over
  32 slices × ~5 transitions each, that's minutes of wasted wall-clock time.
  The server delivers messages instantly via push.
- **No race conditions.** Concurrent file writes to the same inbox directory
  create partial-write and rename-atomicity problems. The server serializes
  all operations in memory.
- **Cleaner agent interface.** Agent tools become simple HTTP calls
  (`POST /messages`, `GET /inbox`) instead of file manipulation. Less surface
  for the LLM to get wrong.
- **The conductor is already long-running.** It's a pi extension — a
  persistent TypeScript process with full Node.js access. Standing up a Unix
  domain socket server inside it is trivial, no extra daemon needed.
- **Crash recovery is equivalent.** If the conductor dies, the human's pi
  session is dead anyway. On restart, the server reloads from its WAL file
  and `state.json`. Same recovery guarantees as filesystem, faster during
  normal operation.

**Server endpoints (Unix domain socket at `.orchestra/bus.sock`):**

```
POST /messages                Send a message
GET  /inbox/:agent-id         Get pending messages for an agent
POST /ack/:msg-id             Acknowledge a message
POST /evidence/:workflow-id   Submit gate evidence
GET  /status                  Workflow engine status (all workflows)
GET  /status/:workflow-id     Single workflow status
POST /heartbeat/:agent-id     Agent heartbeat ping
```

**Message format:**
```json
{
  "id": "msg-uuid",
  "from": "agent-ping",
  "to": "agent-pong",
  "type": "handoff",
  "workflow_id": "tdd-slice-auth",
  "phase": "RED_COMPLETE",
  "timestamp": "2026-02-26T21:00:00Z",
  "payload": { ... },
  "requires_ack": true
}
```

**Delivery semantics:**
- **At-least-once**: Messages are held in-memory and persisted to WAL
  (`.orchestra/bus.wal`) until acknowledged. Survives conductor restart.
- **Non-blocking sends**: `POST /messages` returns immediately with message
  ID and delivery status. Sender never waits for recipient to be free.
  **Eliminates the spam-on-block problem from Claude Code.**
- **Push delivery**: When a message arrives for an agent that has a pending
  `GET /inbox` long-poll, it's delivered immediately. No filesystem scanning.
- **Acknowledgment**: Agent calls `POST /ack/:msg-id` after handling.
  Sender can check delivery status without contacting the receiver.
- **Dead letter**: Messages to non-existent or long-dead agents (no
  heartbeat for > N seconds) are moved to a dead-letter queue and the
  conductor is notified.
- **Deduplication**: Messages carry UUIDs. Server rejects duplicates.
  **Eliminates the duplicate-delivery problem.**
- **Ordering**: Messages within a sender→recipient pair are delivered in
  send order. No global ordering guarantee (not needed).

**Durability:**
- The WAL (`.orchestra/bus.wal`) is an append-only file of message events
  (send, ack, dead-letter). On conductor restart, the WAL is replayed to
  reconstruct the in-memory queue state.
- The WAL is compacted periodically (acknowledged messages are pruned).
- Workflow state (`state.json`) and evidence files remain on the filesystem
  for human inspectability and tool access. The bus handles only transient
  message routing — durable artifacts live on disk.

**Agent-side tools (registered by the scope extension):**

The agent doesn't know about Unix sockets. Its custom tools abstract the
HTTP calls:

```typescript
// In the agent's scope extension
import http from "node:http";

// Helper shared by all agent tools (generated into scope extension)
function busRequest(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: ".orchestra/bus.sock", path, method,
        headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(JSON.parse(data)));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

pi.registerTool({
  name: "send_message",
  description: "Send a message to another agent",
  parameters: Type.Object({
    to: Type.String({ description: "Recipient agent ID" }),
    type: Type.String({ description: "Message type" }),
    payload: Type.Any({ description: "Message payload" }),
  }),
  async execute(id, params) {
    const result = await busRequest("POST", "/messages", {
      from: AGENT_ID,
      to: params.to,
      type: params.type,
      workflow_id: WORKFLOW_ID,
      payload: params.payload,
    });
    return {
      content: [{ type: "text", text: `Message ${result.id} sent to ${params.to}.` }],
    };
  },
});
```

Similarly: `check_inbox` (long-polls `GET /inbox/:agent-id`),
`submit_evidence` (posts to `POST /evidence/:workflow-id`),
`send_heartbeat` (called automatically by the scope extension on an
interval).

### Component 3: Workflow State Machine

TypeScript definitions, deterministic execution.

**Workflow definitions are TypeScript modules** that export a workflow
structure. This gives full expressiveness for custom gate logic, computed
transitions, and parameterization — while the engine that executes them
remains deterministic.

**Loading mechanism:** Workflow definitions are loaded via
[jiti](https://github.com/unjs/jiti) (the same loader pi uses for
extensions). This means TypeScript is executed directly — no compilation
step. The conductor loads all `.ts` files from `.orchestra/workflows.d/`
at startup, and project-specific overrides can shadow package defaults.

```typescript
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const workflow = await jiti.import(".orchestra/workflows.d/tdd-ping-pong.ts");
```

```typescript
// .orchestra/workflows.d/tdd-ping-pong.ts
import { defineWorkflow, evidence, verdict, command } from "@orchestra/core";

export default defineWorkflow({
  name: "tdd-ping-pong",
  description: "Two-agent TDD cycle with domain review",

  params: {
    slice_id: { type: "string", required: true },
    scenario: { type: "string", required: true },
    test_dir: { type: "string", default: "tests/" },
    src_dir:  { type: "string", default: "src/" },
    test_runner: { type: "string", default: "cargo nextest run" },
  },

  roles: {
    ping: {
      agent: "tdd-red",
      tools: ["read", "bash", "edit", "write", "find", "grep", "ls"],
      fileScope: {
        writable: ["${test_dir}**"],
        readable: ["**"],
      },
    },
    pong: {
      agent: "tdd-green",
      tools: ["read", "bash", "edit", "write", "find", "grep", "ls"],
      fileScope: {
        writable: ["${src_dir}**"],
        readable: ["**"],
      },
    },
    domain_reviewer: {
      agent: "domain-review",
      tools: ["read", "bash", "find", "grep", "ls"],
      fileScope: {
        writable: [],
        readable: ["**"],
      },
    },
  },

  states: {
    RED: {
      assign: "ping",
      gate: evidence({
        schema: { test_file: "string", test_name: "string", failure_output: "string" },
        verify: async (ctx) => {
          const result = await ctx.exec(ctx.params.test_runner);
          return result.exitCode !== 0;  // tests must fail
        },
      }),
      transitions: { pass: "DOMAIN_REVIEW_TEST", fail: "RED" },
      maxRetries: 3,
    },

    DOMAIN_REVIEW_TEST: {
      assign: "domain_reviewer",
      inputFrom: ["RED"],
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "GREEN", flagged: "RED" },
      maxRetries: 2,
    },

    GREEN: {
      assign: "pong",
      inputFrom: ["RED", "DOMAIN_REVIEW_TEST"],
      gate: evidence({
        schema: { implementation_files: "string[]", test_output: "string" },
        verify: async (ctx) => {
          const result = await ctx.exec(ctx.params.test_runner);
          return result.exitCode === 0;  // tests must pass
        },
      }),
      transitions: { pass: "DOMAIN_REVIEW_IMPL", fail: "GREEN" },
      maxRetries: 3,
    },

    DOMAIN_REVIEW_IMPL: {
      assign: "domain_reviewer",
      inputFrom: ["GREEN"],
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "COMMIT", flagged: "GREEN" },
      maxRetries: 2,
    },

    COMMIT: {
      type: "action",  // conductor runs directly, no LLM
      commands: [
        "git add -A",
        'git commit -m "TDD: ${scenario}"',
      ],
      gate: command({
        verify: async (ctx) => {
          const status = await ctx.exec("git status --porcelain");
          return status.stdout.trim() === "";
        },
      }),
      transitions: { pass: "CYCLE_COMPLETE", fail: "ESCALATE" },
    },

    CYCLE_COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
```

**Runtime state (`state.json`):**
```json
{
  "workflow_id": "tdd-slice-auth-001",
  "workflow_type": "tdd-ping-pong",
  "current_state": "GREEN",
  "retry_count": 1,
  "params": { "slice_id": "auth-registration", "scenario": "..." },
  "agents": {
    "ping":  { "id": "agent-kent", "pane_id": 3, "status": "idle", "pid": 12345 },
    "pong":  { "id": "agent-greg", "pane_id": 4, "status": "active", "pid": 12346 },
    "domain_reviewer": { "id": "agent-scott", "pane_id": 5, "status": "idle", "pid": 12347 }
  },
  "history": [
    { "state": "RED", "entered_at": "...", "exited_at": "...", "result": "pass", "retries": 0 },
    { "state": "DOMAIN_REVIEW_TEST", "entered_at": "...", "exited_at": "...", "result": "approved" },
    { "state": "GREEN", "entered_at": "...", "result": null, "retries": 1,
      "last_failure": "test still failing: expected 200, got 404" }
  ],
  "evidence": {
    "RED": { "test_file": "tests/auth_test.rs", "failure_output": "...", "verified": true },
    "DOMAIN_REVIEW_TEST": { "verdict": "approved", "concerns": [] },
    "GREEN": null
  },
  "metrics": {
    "RED": { "model": "claude-haiku-4", "tokens_in": 12000, "tokens_out": 3400,
             "cost_usd": 0.004, "latency_ms": 8200, "retries": 0 },
    "DOMAIN_REVIEW_TEST": { "model": "claude-sonnet-4", "tokens_in": 18000,
             "tokens_out": 2100, "cost_usd": 0.02, "latency_ms": 12400, "retries": 0 }
  }
}
```

### Component 4: Agent Lifecycle

**Agents persist within a workflow instance, fresh across instances.**

- A TDD ping-pong workflow for slice X: Kent, Greg, and Scott stay alive
  through all RED→DOMAIN→GREEN→DOMAIN→COMMIT cycles for that slice. When
  slice Y starts, fresh agents are spawned.
- An event modeling session: all experts persist through the full
  multi-round discussion. Fresh when the next session starts.
- A code review workflow: reviewers persist through all three stages and
  rework rounds for that PR. Fresh for the next PR.

The workflow definition can override this per-role with `freshPerState: true`
for roles where isolation is preferred over accumulated context.

**Compaction resilience**: Even when agents persist, the workflow's evidence
lives on disk in `state.json`. If an agent compacts mid-slice, the conductor
re-prompts it with full evidence context from the filesystem, not from the
agent's memory. The agent loses its internal chain of thought but receives
all structured evidence from prior phases.

### Component 5: Tool Scoping (Structural Enforcement)

Each agent spawns with a generated pi extension that enforces file-scope
restrictions by intercepting tool calls:

```typescript
// Generated at .orchestra/runtime/<agent-id>/scope.ts
import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  const WRITABLE = ["tests/**"];
  const ROLE = "RED";

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const path = event.input.path;
      if (!matchesAnyGlob(path, WRITABLE)) {
        return {
          block: true,
          reason: `[BLOCKED] ${ROLE} agent cannot write to ${path}. ` +
                  `Writable paths: ${WRITABLE.join(", ")}`
        };
      }
    }
  });

  // Register submit_evidence, send_message, receive_message, check_inbox
  // ...
}
```

### Component 6: Agent Definitions and Personas

Agent definitions are markdown files with frontmatter, stored in
`.orchestra/agents.d/`. They encode what a role does, not who does it.

```markdown
---
name: tdd-red
description: "Writes failing tests in TDD RED phase"
default_model: claude-haiku-4
---

You are the RED phase agent in a TDD cycle.

[role-specific instructions...]
```

**Personas** are project-specific expert profiles stored in `.team/`.
They encode who the agent is — their expertise, philosophy, voice, and
review focus. Decided per project based on tech stack and domain needs.

The workflow definition binds them together:
```typescript
roles: {
  ping: {
    agent: "tdd-red",                  // what they do
    persona: ".team/kent-beck.md",     // who they are
    // ...
  },
}
```

The agent's system prompt becomes: persona (who) + agent definition (what)
+ workflow context (evidence, phase, constraints).

### Component 7: Zellij Integration

**Pane layout for TDD:**
```
┌──────────────────────────────────────┐
│  Human's pi  (conductor extension)   │
│  [workflow status widget]            │
├──────────────────┬───────────────────┤
│  Kent Beck (RED) │  Greg Johnston    │
│  [writing test]  │  (GREEN) [idle]   │
├──────────────────┴───────────────────┤
│  Scott Wlaschin (DOMAIN) [idle]      │
└──────────────────────────────────────┘
```

**Agent spawning:**
```bash
zellij action new-pane --name "agent-kent" --direction down -- \
  pi --mode json -p --no-session \
  -e .orchestra/runtime/agent-kent/scope.ts \
  --model claude-haiku-4 \
  --append-system-prompt .orchestra/runtime/agent-kent/prompt.md \
  "$(cat .orchestra/runtime/agent-kent/initial-task.md)"
```

**Human interaction modes:**
- **Watch**: Focus any agent's pane in zellij, observe in real time
- **Chat**: Focus a pane, type in pi's input — goes to that agent directly
- **LLM-invoked tools**: In the conductor's pi session (the human's main
  pane), the human says "start the TDD workflow for auth registration" and
  the LLM calls `orchestra_start`. Or "what's the status?" → LLM calls
  `orchestra_status`. The tools are registered for the LLM to use; the
  human communicates in natural language.
- **Slash commands**: For direct invocation without LLM intermediation,
  Orchestra also registers `/orchestra <subcommand>` as a pi command.
  `/orchestra status` shows status immediately without an LLM turn.
  `/orchestra pause` pauses immediately. These are for when the human
  wants instant response, not a conversation.
- **Override**: `orchestra_override` (LLM tool) or `/orchestra override`
  (command) to force a gate result
- **Pause**: `orchestra_pause` or `/orchestra pause` freezes the state machine
- **Takeover**: Kill an agent, do the work yourself, submit evidence
  manually via `orchestra_override`

### Component 8: Independent Verification

Gates don't trust agents. The conductor verifies claims:

| Agent Claims | Conductor Verifies |
|---|---|
| "Tests fail" (RED) | Runs test suite, confirms nonzero exit |
| "Tests pass" (GREEN) | Runs test suite, confirms zero exit |
| "Review: APPROVED" | Checks review file exists with required structure |
| "Mutation: 100% kill" | Runs mutation tool, checks output |
| "CI green" | Calls CI API, confirms status |

Verification logic is defined in the workflow's gate functions — arbitrary
TypeScript that the engine executes deterministically.

### Component 9: Model Tuner

The audit trail produces a dataset of (model, role, phase, quality, cost,
latency) tuples. The tuner:

1. **Collects** per-phase metrics from every workflow execution: model used,
   tokens in/out, cost, latency, retry count, rework count, gate pass/fail,
   human override count.

2. **Analyzes** after N completions: which roles are over-specced (Sonnet
   where Haiku would do), which are under-specced (Haiku producing too many
   retries), where the cost/quality tradeoff is suboptimal.

3. **Proposes** model changes to `.orchestra/tuning/recommendations.json`.
   Recommendations include the data supporting the change (e.g., "RED phase
   with Haiku: 2.1 avg retries, $0.003/phase. RED with Sonnet: 0.4 avg
   retries, $0.02/phase. Recommendation: keep Haiku, retry cost is lower
   than model upgrade.").

4. **A/B tests** approved changes: run the next N workflows with the new
   model, compare metrics, auto-revert if quality degrades.

5. **Learns** from human overrides and escalations as strong negative
   signals: if a human overrides a gate on a Haiku-produced phase, that's
   evidence the model is under-specced.

**Default model assignments (starting point):**

| Role | Default Model | Rationale |
|---|---|---|
| RED (test writing) | Haiku/fast | Mechanical, tool-scoped, retries cheap |
| GREEN (implementation) | Haiku/fast | Mechanical, tool-scoped, retries cheap |
| Domain review | Sonnet w/ high thinking | Requires reasoning about types |
| Code review | Opus or Sonnet | Nuanced judgment, happens less often |
| Event modeling | Opus or Sonnet | Creative, architectural |
| Discovery/planning | Opus or Sonnet | Strategic, high-stakes decisions |
| Mechanical (git, CI) | No LLM | Conductor runs shell commands |

Also worth evaluating: GPT-5.3-codex for coding phases, Gemini for fast
iteration, etc. The tuner is model-agnostic — it measures outcomes, not
brand loyalty.

## Full Lifecycle Workflows

Orchestra covers the complete SDLC in two flavors that share most phases
but diverge on requirements capture.

### Flavor A: Event-Modeled

```
Discovery → Event Modeling → UI Design System → Architecture Planning
    → Development (pipeline) → Review → Human Acceptance
```

Best for: domain-rich applications (bread_log, healthcare, finance),
event-sourced systems, projects where the domain model IS the product.

### Flavor B: Traditional PRD

```
Discovery → PRD → UI Design System → Architecture Planning
    → User Story Breakdown + Project Tracking Setup
    → Development (pipeline) → Review → Human Acceptance
```

Best for: CRUD apps, API services, projects where requirements are
well-understood, teams familiar with traditional agile.

### Shared Phases

Both flavors share:

1. **Discovery** — Domain exploration, SME consultation, user needs
   analysis. Consensus-decision workflow with domain experts.
   Output: domain understanding, key terminology, user goals.

2. *(fork: Event Modeling OR PRD)*

3. **UI Design System** — Component catalog, design tokens, visual
   language. Expert agents (designer, a11y specialist) produce Pencil.dev
   (or equivalent) artifacts. Output: design system spec, component catalog.

4. **Architecture Planning** — ADRs, tech stack decisions, infrastructure.
   Consensus-decision workflow with technical experts.
   Output: ARCHITECTURE.md, ADRs, infrastructure plan.

5. **Development** — The pipeline: slice queue → TDD ping-pong → three-stage
   review → mutation testing → CI → merge. Iterates over all slices.
   Includes exploratory QA workflow to catch gaps like the design system
   compliance failure in bread_log.

6. **Review** — Human acceptance review. Configurable cadence: every slice,
   every N slices, end-of-project, or continuous. Human can approve, reject
   with feedback (routes to rework), or pause the pipeline.

### Divergent Phase: Event Modeling (Flavor A)

Consensus-decision workflow with domain experts producing:
- Commands, events, read models
- GWT scenarios per workflow
- Vertical slice specs with acceptance criteria
- Domain glossary

Output: slice queue ready for the development pipeline.

### Divergent Phase: PRD (Flavor B)

Consensus-decision workflow producing:
- Product requirements document
- User stories with acceptance criteria
- Project tracking setup (GitHub issues, etc.)
- Story breakdown into implementable units

Output: slice queue (or story queue) ready for the development pipeline.

### Both Produce the Same Artifact

The development pipeline doesn't care how requirements were captured. It
consumes a queue of implementable units, each with:
- Acceptance criteria (GWT or user story format)
- Domain context (types, events, or data model)
- UI context (design system components, if applicable)
- Dependencies (which units must complete first)

### Key Workflow Sketches (Phase 3 detail)

The `tdd-ping-pong` workflow is fully specified above in Component 3. Here
are structural sketches for the other workflows — enough detail that an
implementor can build them without guessing.

**consensus-decision.ts** — Multi-expert structured discussion with voting.
Used by: discovery, event modeling, architecture planning, PRD.

```
States: SEED → DISCUSS (N rounds) → VOTE → RESOLVE → COMPLETE | ESCALATE

Roles: facilitator, expert-1..N (parameterized count)
Gate (DISCUSS → VOTE): all experts have submitted position statements
Gate (VOTE → RESOLVE): all experts voted, check for consensus (≥ threshold)
Gate (RESOLVE → COMPLETE): facilitator submits synthesis document
If no consensus after M rounds: ESCALATE to human

Evidence: position statements, vote tallies, synthesis document
```

**three-stage-review.ts** — Code review pipeline: syntax → domain → holistic.

```
States: SYNTAX_REVIEW → DOMAIN_REVIEW → HOLISTIC_REVIEW → APPROVED | REWORK

Roles: syntax-reviewer, domain-reviewer, holistic-reviewer
Gate (each stage): verdict {approved | flagged} with structured feedback
If flagged at any stage: transition to REWORK
REWORK dispatches back to the original workflow's agent with feedback

Independent verification: reviewer file exists, has required structure
```

**pipeline.ts** — Composes sub-workflows for a full slice.

```
States: SETUP → TDD_CYCLE (loop) → REVIEW → MUTATION → CI → MERGE → DONE

SETUP: create branch, load slice spec
TDD_CYCLE: instantiate tdd-ping-pong sub-workflow per scenario (loop)
REVIEW: instantiate three-stage-review sub-workflow
MUTATION: run mutation testing (conductor action, no LLM)
CI: wait for CI (conductor action, poll CI API)
MERGE: merge branch (conductor action)

Gate (TDD_CYCLE → REVIEW): all scenarios have passing tdd-ping-pong
Gate (REVIEW → MUTATION): review approved
Gate (MUTATION → CI): mutation score ≥ threshold
Gate (CI → MERGE): CI green
```

**exploratory-qa.ts** — Catch gaps the pipeline missed (like design system).

```
States: SETUP → EXPLORE → REPORT → TRIAGE → FIX | PASS

Roles: qa-analyst
The QA analyst receives the full slice diff + design system spec +
acceptance criteria and looks for: visual gaps, a11y violations, missing
edge cases, inconsistencies with design tokens, etc.

Gate (EXPLORE → REPORT): structured findings document
Gate (TRIAGE → FIX or PASS): human reviews findings, decides action
```

**retro.ts** — Post-slice retrospective producing structured proposals.

```
States: COLLECT → ANALYZE → PROPOSE → HUMAN_REVIEW → APPLY | SKIP

Roles: retro-facilitator, participating agents (from the completed workflow)
COLLECT: each agent submits structured reflection (what worked, what didn't)
ANALYZE: facilitator synthesizes into themes
PROPOSE: facilitator produces proposals.json with specific changes
HUMAN_REVIEW: human approves/rejects each proposal
APPLY: conductor applies approved patches to workflow definitions
```

## Retrospectives and Adaptation

The ensemble-team formation session is dropped. The workflow definitions
encode how agents work together — non-negotiable structure that doesn't
need to be negotiated.

What remains:

1. **Retrospective workflow** runs after each slice (or configurable
   cadence). Agents in the workflow can propose changes based on problems
   encountered.

2. **Proposals are structured**, not prose. A retro produces a
   `.orchestra/retro/<slice-id>/proposals.json` with specific, actionable
   items: "add a gate for design system compliance in the review workflow,"
   "increase retry budget for mutation testing from 3 to 5."

3. **Human approves or rejects** each proposal. Approved proposals become
   workflow definition patches — actual code changes to the TypeScript
   workflow files. The conductor applies approved patches before the next
   workflow instance.

4. **The tuner feeds into retros.** Model performance data is available to
   the retro workflow. Agents can propose model changes based on their
   experience ("domain review felt under-powered with Haiku, recommend
   Sonnet") which the tuner validates against the metrics.

## Project Configuration

Workflow definitions are universal (ship with the package). What's
project-specific is a configuration file:

```typescript
// .orchestra/project.ts
import { defineProject } from "@orchestra/core";

export default defineProject({
  name: "bread-log",
  flavor: "event-modeled",  // or "traditional-prd"

  // Tech-stack-specific commands and paths
  testRunner: "cargo nextest run",
  buildCommand: "cargo build",
  lintCommand: "cargo clippy --workspace -- -D warnings",
  formatCheck: "cargo fmt --check",
  mutationTool: "cargo mutants --test-tool nextest --in-place",
  ciProvider: "github-actions",

  // File patterns
  testDir: "**/*_test.rs",
  srcDir: "src/",
  typeDir: "src/",  // where domain types live

  // Team (project-specific personas)
  team: [
    { role: "product-manager", persona: ".team/marty-cagan.md" },
    { role: "domain-sme", persona: ".team/ken-forkish.md" },
    { role: "domain-architect", persona: ".team/scott-wlaschin.md" },
    { role: "lead-engineer", persona: ".team/greg-johnston.md" },
    { role: "senior-engineer", persona: ".team/jon-gjengset.md" },
    { role: "dev-practice-lead", persona: ".team/kent-beck.md" },
    { role: "ux-specialist", persona: ".team/luke-wroblewski.md" },
    { role: "ui-designer", persona: ".team/steve-schoger.md" },
    { role: "a11y-specialist", persona: ".team/heydon-pickering.md" },
    { role: "qa-analyst", persona: ".team/lisa-crispin.md" },
  ],

  // Autonomy
  autonomyLevel: "full",
  humanReviewCadence: "end",  // "every-slice" | "every-n" | "end"
  reworkBudget: 5,
});
```

## Repository

Lives at `jwilger/pi-orchestra`. Ships as a pi package:
```bash
pi install git:github.com/jwilger/pi-orchestra
```

Includes:
- Conductor extension (TypeScript)
- Workflow engine
- Message bus implementation
- Default workflow definitions (tdd-ping-pong, consensus-decision, pipeline,
  discovery, event-modeling, prd, three-stage-review, exploratory-qa, retro)
- Default agent definitions (tdd-red, tdd-green, domain-review, etc.)
- Model tuner
- Zellij integration

Projects add `.orchestra/project.ts` and `.team/` profiles.

## Development Standards

Orchestra is built using the same discipline it enforces. No exceptions.

### Why This Matters

This is not a developer tool that fails gracefully with a helpful error
message. Orchestra runs autonomously for hours, making consequential
decisions without human oversight:

- **It spawns processes and spends money.** A runaway workflow that doesn't
  respect retry budgets burns API credits indefinitely.
- **It commits and merges code.** A state machine bug that skips the review
  gate means unreviewed code lands on main. A bug that advances past
  mutation testing means untested code ships.
- **It enforces role boundaries.** If tool scoping has a path-matching bug,
  the structural enforcement — the entire reason this project exists — is
  theater. A RED agent edits production code, the gate doesn't catch it,
  and we're back to prompt-and-pray.
- **It manages durable state.** A WAL bug that drops messages means the
  pipeline stalls (best case) or advances without evidence (worst case). A
  state.json corruption means the workflow resumes in the wrong phase.
- **It operates on codebases that matter.** The bread_log project has 32
  shipped slices and 400+ tests. A real product. Orchestra will operate on
  more projects like it. Bugs here have blast radius.

Every component must be tested at the behavioral boundary with mutation
testing confirming there are no gaps. "It works on the happy path" is not
sufficient when the system runs unsupervised.

### Architecture — Functional Core / Imperative Shell

The codebase follows a strict functional-core/imperative-shell architecture
with railway-oriented error handling throughout.

**Functional core:**
- All workflow engine logic, state machine transitions, gate evaluation,
  evidence validation, message routing decisions, metric analysis
- Pure functions: input → output, no side effects, no I/O
- All errors are values in a Result type, never thrown exceptions
- Railway-oriented programming: operations compose via `Result<T, E>` chains
  where failures short-circuit through the error track without try/catch
- The core is where all the important logic lives and is trivially testable
  because it has no dependencies on I/O, time, or external state

**Imperative shell:**
- HTTP server (bus socket), file I/O (state.json, WAL, evidence), process
  spawning (zellij panes, pi agents), shell command execution (independent
  verification), pi extension registration (tools, events, commands)
- The shell is thin: it reads from the world, calls pure core functions,
  and writes the results back to the world
- The shell is where I/O boundaries live and where domain types are parsed
  from raw input (HTTP request bodies, JSON files, CLI output) and
  serialized back to primitives for output

**No primitive obsession — domain types for everything:**
- `WorkflowId`, not `string`
- `AgentId`, not `string`
- `PaneId`, not `number`
- `GateResult`, not `{ passed: boolean }`
- `Evidence<T>`, not `Record<string, unknown>`
- `MessageId`, not `string`
- `RetryCount` with a max bound, not `number`
- `FileScopePattern`, not `string[]`
- `WorkflowState` as a discriminated union, not a string enum

**Parse-don't-validate at every boundary:**
- HTTP request bodies are parsed into domain types at the handler. If
  parsing fails, the error is returned immediately — invalid data never
  reaches the core.
- JSON files (`state.json`, evidence, WAL entries) are parsed through
  schema validation into domain types on read. Corrupted files produce
  typed errors, not runtime crashes.
- Shell command output (test runner, mutation tool, CI API) is parsed into
  domain types (`TestResult`, `MutationScore`, `CiStatus`). Raw strings
  never flow into core logic.
- Agent tool parameters are validated and parsed before the tool handler
  runs. The LLM submitting malformed evidence gets a typed rejection, not
  an internal error.

**Conversion back to primitives only at I/O boundaries:**
- Serializing `state.json` to disk
- Formatting HTTP responses
- Generating agent prompt text from evidence
- Writing WAL entries
- Rendering UI widgets

The core never sees a raw string where a domain type should be. The shell
never contains business logic. This separation means the core can be tested
exhaustively with pure function calls and the shell is thin enough that
integration tests cover its small surface area.

### TDD — The Same Rules We Enforce on Others

Every feature is built through RED → DOMAIN → GREEN → DOMAIN → COMMIT
cycles. The TDD skill's rules apply to this project:

- **One failing test before any implementation.** No "let me just scaffold
  this first." The test comes first.
- **Behavioral tests, not implementation tests.** Tests assert on observable
  outcomes: "when an agent submits evidence and the gate verification passes,
  the workflow advances to the next state and the assigned agent receives a
  dispatch message." Tests do NOT assert on internal data structures,
  private method calls, or implementation details.
- **Outside-in.** Start from the boundary — the pi extension tools, the HTTP
  endpoints, the agent-facing tool interfaces. Drill inward through unit
  tests. The acceptance test stays RED while inner tests go through their
  own cycles.
- **Domain types over primitives.** `WorkflowId`, not `string`. `AgentRole`,
  not `string`. `GateResult`, not `{ passed: boolean }`. Parse-don't-validate
  at every boundary.
- **Phase boundaries enforced.** RED phase: only test files. GREEN phase:
  only production code. Domain review after every RED and GREEN.

### Mutation Testing — 100% Kill Rate

Every change runs mutation testing. Survivors are test gaps and must be
addressed before the commit is complete. This is the same standard the
orchestra enforces on projects that use it — we eat our own dog food.

### What "Behavioral" Means Concretely

Tests are written from the perspective of the actors that interact with the
system:

**For the workflow engine:**
- Actor: the conductor extension code that calls engine functions
- Tests assert: given a workflow in state X with evidence Y submitted, the
  engine transitions to state Z and dispatches work to agent W
- Tests do NOT assert: internal state machine implementation, data structure
  shapes, intermediate computation

**For the message bus server:**
- Actor: agents making HTTP requests to the bus socket
- Tests assert: a message POSTed to `/messages` is retrievable via
  `GET /inbox/:agent-id`; acknowledged messages are no longer delivered;
  messages survive conductor restart via WAL replay
- Tests do NOT assert: in-memory queue implementation, WAL file format
  details

**For tool scoping:**
- Actor: an LLM making tool calls through the pi extension API
- Tests assert: an `edit` call to a path outside the writable scope returns
  a block response; an `edit` call within scope succeeds
- Tests do NOT assert: glob matching implementation internals

**For the conductor extension:**
- Actor: the human's pi session invoking orchestra tools
- Tests assert: `orchestra_start` with valid params creates a workflow,
  spawns agents, and the first state's assigned agent receives its dispatch;
  `orchestra_status` returns current state and agent health
- Tests do NOT assert: zellij CLI invocation details, internal extension
  wiring

### Test Infrastructure

- **Test runner:** Vitest (or the project's chosen TS test runner)
- **Mutation tool:** Stryker (for TypeScript)
- **Integration tests:** Spin up the bus server on a temp Unix socket, run
  workflows against it with mock agents (simple scripts that submit
  predetermined evidence)
- **No mocking of the bus.** The bus server is fast (in-process Unix socket).
  Tests use a real bus instance. Mock only external boundaries (zellij CLI,
  child processes for agent spawning, shell commands for independent
  verification).

## Implementation Plan

### Phase 1: Core Engine + Data Collection

**Goal**: Workflow state machine + message bus server + basic agent spawning +
metrics collection from day one.

- Workflow definition TypeScript API (`defineWorkflow`, gate helpers)
- State machine engine (event-driven transition logic, retry, escalate)
- **Message bus server**: Unix domain socket HTTP server inside the conductor
  extension. Endpoints for messages, evidence, heartbeats, status. WAL-based
  persistence for crash recovery.
- Evidence collection (`submit_evidence` tool posts to bus server)
- Agent-side tools (`send_message`, `check_inbox`, `submit_evidence`) that
  abstract HTTP calls to the bus socket
- Basic conductor extension (`orchestra_start`, `orchestra_status`)
- Independent verification (run shell commands, check results)
- **Metrics collection**: every phase records model, tokens, cost, latency,
  retries, outcome — from the very first workflow run
- Tool scoping (structural enforcement of file-scope restrictions)
- One test workflow: a simple TDD cycle to prove the engine end-to-end

### Phase 2: Zellij Integration

**Goal**: Agents in panes, human can observe and interact.

- Spawn agents in zellij panes via `zellij action`
- Pane lifecycle (create, monitor liveness, kill)
- Layout templates per workflow type
- Human focus/interaction with any pane
- `orchestra_kill`, `orchestra_pause`, `orchestra_resume` commands

### Phase 3: Workflow Library

**Goal**: Production-ready workflows for the full SDLC.

- tdd-ping-pong.ts with role swapping and cycle iteration
- consensus-decision.ts with structured voting
- three-stage-review.ts
- pipeline.ts composing sub-workflows
- discovery.ts, event-modeling.ts, prd.ts
- exploratory-qa.ts
- retro.ts with structured proposal output
- Agent definitions with persona integration

### Phase 4: Model Tuner

**Goal**: Adaptive model selection based on real-world results.

- Metric aggregation across workflow executions
- Analysis: per (model, role, phase) quality/cost/latency
- Recommendation engine with supporting data
- A/B testing framework for model changes
- Human approval workflow for recommendations
- Auto-revert on quality degradation

### Phase 5: Conductor UI

**Goal**: Rich observability in the human's pi session.

- Pi widget showing live workflow state diagram
- State transition notifications
- Agent health/heartbeat display
- Cost/token tracking per agent and per workflow
- Escalation UI
- Model tuner dashboard (current assignments, recommendations, A/B results)

## Relationship to Existing Skills

| Skill | Orchestra Equivalent |
|-------|---------------------|
| `tdd` | `tdd-ping-pong.ts` + RED/GREEN/DOMAIN agent definitions |
| `pipeline` | `pipeline.ts` + conductor engine loop |
| `agent-coordination` | **Eliminated.** Bus + state machine make coordination structural. |
| `ensemble-team` | Persona integration. Formation session dropped. Retro workflow replaces ongoing adaptation. |
| `code-review` | `three-stage-review.ts` + reviewer agent definitions |
| `mutation-testing` | Gate action with independent verification |
| `memory-protocol` | **Eliminated for coordination.** `state.json` IS the memory. |
| `error-recovery` | Retry/escalate logic in the state machine |
| `event-modeling` | `event-modeling.ts` workflow in the discovery phase |
| `design-system` | Part of the UI Design System phase + exploratory QA gate |

## Name

**Orchestra** — a conductor coordinates specialized musicians who each play
their part, following a score, with the audience free to listen or jump on
stage.
