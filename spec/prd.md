# Conductor — Agent Orchestration Harness: Architecture & PRD

Nov 10, 2026 · @Michael DiMuro

## Summary

Conductor (working name) is a local-first, always-on agent orchestration harness for macOS. It runs as a launchd daemon, models work as **organizations → departments → agents**, and drives agents toward goals through a ticket-and-heartbeat loop. Every agent carries its own skills, MCP connectors, model provider, budget and long-term memory, and gets measurably better at its job over time.

**Problem.** Today's options each solve one slice. Paperclip models a company and governs agents but leaves learning and memory to the agent runtime. Hermes learns and writes its own skills but is a single agent, not an org. CrewAI composes role-based crews but runs as a script, not a persistent workforce. No single tool gives one person a durable, multi-org, self-improving agent workforce on their own machine.

### Goals

1. **Always on.** Starts at login/boot via launchd, survives crashes and reboots, resumes in-flight work.
2. **Org modeling.** Create and manage many organizations, each with departments, agents, goals and budgets.
3. **Per-agent capability scoping.** Each agent has its own skills, MCP connectors, credentials, browser profile and provider.
4. **Provider-agnostic.** Ship OpenAI API, Codex local, Claude local (Claude Code) and Claude API adapters; new providers plug in without core changes.
5. **Goal-driven autonomy.** Agents decompose goals into issues, check them out atomically, execute, report, and escalate only when needed.
6. **Continuous learning.** Agents author, test and revise their own skills, and keep long-term memory that makes their work more consistent.
7. **Real-world reach.** Agents use a real browser, and a human can join a live browser session remotely to complete logins and MFA.

### Non-goals (v1)

- Multi-tenant SaaS hosting. v1 is single-owner, local-first; remote access is to *your* machine.
- Training or fine-tuning model weights. "Learning" means memory, skills and prompt artifacts, not gradients.
- Windows/Linux service managers. The daemon is portable, but only launchd packaging ships in v1.
- A visual workflow builder. Structure comes from goals, issues and skills, not drag-and-drop graphs.

## What we borrow, and what we add

Conductor takes the org model from Paperclip, the learning loop from Hermes, and the agent persona and process model from CrewAI. It then fuses them into one always-on runtime.

| Source | Borrowed | How Conductor changes it |
| --- | --- | --- |
| [Paperclip](https://github.com/paperclipai/paperclip) | Multi-company isolation; org chart with reporting lines; goal-linked issues with parents, blockers and comments; heartbeats; atomic task checkout; per-company/agent/project budgets with hard stops; board approvals; revisioned config; adapter model (`claude_local`, `codex_local`, `process`, `http`, …); MCP Tool Gateway with Allowed / Ask first / Off per action | Adds native long-term memory, skill self-authoring and a browser service to the control plane instead of leaving them to each runtime. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Closed learning loop; autonomous skill creation after complex tasks, refined with use; agentskills.io skill format; FTS5 session search + LLM summaries; MEMORY.md / USER.md; Honcho-style user modeling; natural-language cron; multi-platform messaging gateway | Applies the loop per agent inside an org, with evals and promotion so one agent's learning can spread to its department. |
| [CrewAI](https://docs.crewai.com/en/introduction) | Agent `role` / `goal` / `backstory`; tasks with `expected_output`; sequential and hierarchical (manager-delegated) processes; Flows for event-driven control; unified scoped memory ranked by similarity, recency and importance | Processes become reusable **playbooks** that agents run inside issues; memory scopes map onto org → dept → agent. |

**Net new in Conductor:** launchd-native always-on daemon, human-takeover browser sessions for auth, eval-gated skill promotion, and memory designed for job consistency (procedures, preferences, entity facts) rather than chat recall.

## Personas and use cases

The primary user is a solo founder or operator running several ventures from one Mac, who wants agents doing real work while they sleep.

| Persona | Needs | Representative use case |
| --- | --- | --- |
| **Owner / Board** (primary) | Set goals, approve risky actions, see cost and progress across orgs | "Run Acme's outbound and Beta Labs' content pipeline; ping me only for approvals over $50." |
| **Department lead agent** | Break department goals into issues, assign and review work | Marketing lead turns "grow newsletter to 10k" into weekly content, SEO and partnership issues |
| **Specialist agent** | Narrow tools, sharp skills, memory of past work | SEO agent audits pages via browser, files fixes as issues for the Web agent |
| **Operator / developer** | Add providers, connectors, skills; debug runs | Adds a Gemini adapter and a custom internal MCP server without touching core |
| **Remote helper** (optional) | Complete a login or CAPTCHA the agent can't | Opens a share link on their phone, signs in to a bank portal, hands control back |

### Core use cases

1. Stand up a new organization from a template (e.g. "SaaS startup": CEO, Engineering, Marketing, Support) in under 5 minutes.
2. Set an org goal; watch the CEO agent cascade it into department goals and issues.
3. Agents work unattended overnight across orgs, within budget, and produce a morning digest.
4. An agent hits a login wall, requests a human, and the owner completes auth from their phone.
5. An agent repeats a task three times, distills a skill from it, and the fourth run is faster and cheaper.
6. The owner reviews, edits or rolls back a skill or memory an agent wrote.

## System architecture

One daemon, `conductord`, is the control plane. Agents never talk to models, tools or websites directly: every call goes through an adapter, the connector gateway or the browser service. That is where scoping, approvals, cost and audit are enforced.

&#91;embedded content: System architecture · clients, daemon, outside systems\]

The top row of the daemon decides *what* runs and *when*. The bottom row is *how* a run reaches the world. Every run passes through all four outward components, so one policy layer covers every provider.

## Domain model

Everything is scoped by `org_id`. An organization is a hard isolation boundary: its agents, memory, secrets, browser profiles and budgets never leak across orgs unless the owner explicitly shares a resource.

| Entity | Key fields | Notes |
| --- | --- | --- |
| **Organization** | id, name, mission, owner, budget\_monthly\_usd, default\_provider, policies | Top-level tenant. Created blank or from a template. |
| **Department** | id, org\_id, name, charter, lead\_agent\_id, budget\_usd, shared\_skills\[\], shared\_connectors\[\] | Groups agents; capabilities set here are inherited by members. |
| **Agent** | id, dept\_id, name, role, goal, backstory, reports\_to, provider\_binding, model, skills\[\], connectors\[\], browser\_profile\_id, heartbeat\_cron, budget\_usd, autonomy\_level, status | CrewAI-style persona (role/goal/backstory) + Paperclip-style employee record. |
| **Goal** | id, org\_id, parent\_goal\_id, owner\_agent\_id, title, success\_metric, target, due, status | Tree: org goal → dept goals → agent goals. Every issue traces to a goal. |
| **Project** | id, org\_id, goal\_id, name, workspace\_path | Optional grouping; owns a working directory or repo. |
| **Issue** | id, org\_id, goal\_id, project\_id, title, body, assignee\_agent\_id, status, priority, parent\_issue\_id, checkout\_lock, labels | The unit of work. Statuses: backlog → todo → in\_progress → in\_review → done, plus blocked and cancelled. |
| **Comment** | id, issue\_id, author (agent or human), body, attachments | Threaded conversation on an issue; the main channel between agents. |
| **Run** | id, agent\_id, issue\_id, trigger, provider, started\_at, ended\_at, tokens\_in/out, cost\_usd, outcome, transcript\_ref | One heartbeat execution. Full transcript stored for learning and audit. |
| **Skill** | id, scope (global/org/dept/agent), name, version, author (human/agent), status, eval\_score | Folder-based SKILL.md package; versioned. |
| **Connector** | id, scope, kind (mcp\_stdio/mcp\_http/composio/arcade/…), config, auth\_ref, tool\_allowlist | An MCP server or toolkit an agent may use. |
| **Memory** | id, scope, kind, content, embedding, source\_run\_id, confidence, last\_used\_at | See the memory section. |
| **Approval** | id, org\_id, requester\_agent\_id, kind, payload, status, decided\_by | Board-gated actions: hires, budget raises, spend, external sends. |
| **BrowserProfile** | id, org\_id, agent\_id?, user\_data\_dir, cookie\_vault\_ref | Persistent Chromium profile; one per agent or shared per dept. |

**Capability resolution.** An agent's effective skills and connectors are `org defaults ∪ department shared ∪ agent own`, minus anything on an explicit deny list. Resolution happens at run start and is snapshotted onto the Run for audit.

**Reporting lines.** `reports_to` forms an org chart. Delegation flows down it; escalation flows up it; the Owner is the root. An agent may assign an issue only to itself, its reports, or a peer through its lead.

## Runtime: daemon, scheduler and the work loop

One long-lived process, `conductord`, owns the database, scheduler and API. Agent runs execute as supervised child processes so a crashing agent never takes down the daemon.

### Auto-start with launchd

- Installed by `conductor install` as a **LaunchAgent** at `~/Library/LaunchAgents/ai.conductor.daemon.plist`. A LaunchAgent (not a LaunchDaemon) is required because agents need the logged-in user's Keychain, browser and GUI session.
- `RunAtLoad=true`, `KeepAlive={SuccessfulExit:false}`, `ThrottleInterval=10`, stdout/stderr to `~/Library/Logs/Conductor/`.
- For true boot-without-login, an optional LaunchDaemon variant runs a headless profile (no Keychain; secrets from an encrypted file vault), documented as advanced.
- `caffeinate`-style power assertion while runs are active; on wake from sleep, the scheduler fires missed heartbeats once (no thundering herd).

```xml
<key>Label</key><string>ai.conductor.daemon</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/conductord</string><string>--serve</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
```

### Scheduler and triggers

Agents wake on **heartbeats** (cron per agent, e.g. every 30 min for a lead, hourly for a specialist) and on **events**: issue assigned, comment mentioning the agent, approval decided, webhook from a connector, or a manual "run now". Concurrency limits apply per org, per provider (to respect rate limits and local CLI seats) and globally.

### The heartbeat loop (one Run)

1. **Wake and resolve.** Load agent config, snapshot effective skills, connectors and budget remaining. Abort if over budget or paused.
2. **Recall.** Pull the agent's working memory, relevant long-term memories, and the skill index (names + one-line descriptions only).
3. **Inbox.** Read assigned issues, new comments and mentions, ordered by priority and goal weight.
4. **Checkout.** Atomically claim one issue (`UPDATE … SET checkout_lock = run_id WHERE checkout_lock IS NULL`). Losers move on; no two agents ever work the same issue.
5. **Plan.** If the issue is large, split it into child issues and delegate down the reporting line; otherwise plan steps.
6. **Execute.** Hand the prompt, tools and skills to the provider adapter. Tools route through the connector gateway; browser actions through the browser service.
7. **Report.** Post a comment with results and artifacts, update status (done / in\_review / blocked with reason), record cost.
8. **Reflect.** A post-run reflection writes memory candidates and skill proposals (see Learning loop).
9. **Sleep** until the next heartbeat or event.

### Autonomy levels (per agent)

| Level | Behavior |
| --- | --- |
| 0 · Assist | Only acts on explicitly assigned issues; every external action needs approval. |
| 1 · Supervised | Creates its own sub-issues; external writes (send, post, pay) need approval. |
| 2 · Autonomous | Pursues goals proactively, creates issues, acts within budget and policy; only policy-flagged actions need approval. |
| 3 · Lead | Level 2 plus may propose hires, reassign work and set department goals (hires still board-approved). |

**Crash safety.** Runs are journaled. On daemon restart, runs marked in-flight are either resumed (adapters with session resume, e.g. Claude Code `--resume`, Codex sessions) or released back to `todo` with a comment.

## Model provider adapters

Providers sit behind one `AgentAdapter` contract. There are two families, and the harness treats them differently.

- **API adapters** (OpenAI API, Claude API): Conductor owns the agent loop. It sends messages and tool schemas, executes tool calls itself, and streams results back. Full control over tools, memory injection and cost metering.
- **Local agent-CLI adapters** (Claude local = Claude Code, Codex local = Codex CLI): the CLI owns the inner loop. Conductor spawns it in the issue's workspace, injects skills, MCP config and the task prompt, and parses its structured output stream. These reuse the user's existing subscriptions and logins.

| Adapter | Transport | Auth | Tools / MCP injection | Session resume | Cost source |
| --- | --- | --- | --- | --- | --- |
| `claude_api` | Anthropic Messages API | API key (Keychain) | Native tool use + MCP connector | Conductor transcript | Token usage × price table |
| `openai_api` | OpenAI Responses API | API key (Keychain) | Function tools + remote MCP | Conductor transcript | Token usage × price table |
| `claude_local` | `claude -p --output-format stream-json` subprocess | User's Claude login | Generated `--mcp-config`, skills copied to `.claude/skills/`, `--append-system-prompt` | `--resume <session_id>` | Reported usage; subscription runs flagged $0 marginal |
| `codex_local` | `codex exec --json` subprocess | User's ChatGPT/Codex login or key | Generated `config.toml` MCP block, skills as `AGENTS.md` sections | Codex session id | Reported usage |

### Adapter contract

```ts
interface AgentAdapter {
  id: string;                          // "claude_local"
  capabilities(): { tools: boolean; mcp: boolean; resume: boolean; vision: boolean; browser: "native" | "via_mcp" };
  testConnection(cfg): Promise<Health>;
  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
}
```

`RunContext` carries the prompt, resolved skills, MCP endpoint list (always pointing at the Conductor connector gateway), workspace path, budget cap and a run-scoped API token. `RunEvent` normalizes text, tool calls, tool results, usage and errors so the UI, cost ledger and learning loop never care which provider ran.

### Adding providers later

Adapters are npm packages discovered from `~/.conductor/adapters/` or the registry, declared in a manifest (`id`, config JSON schema, capabilities). Candidates in the backlog: Gemini API, Gemini CLI, OpenRouter, Ollama / LM Studio (local models), OpenCode, Cursor agent, Hermes agent, and a generic `process` / `http` adapter that runs any command or calls any webhook. Two generic adapters mean any agent with a CLI or HTTP API works on day one.

**Routing and fallback.** Each agent has a primary binding and an optional fallback chain (e.g. `claude_local → claude_api → openai_api`) used on rate limit, auth failure or outage. A cheap "utility model" per org handles reflection, summarization and memory extraction.

## Skills system

A skill is a folder with a `SKILL.md` (YAML front matter + instructions) and optional `scripts/`, `references/` and `assets/`, compatible with the open Agent Skills format used by Claude Code, Codex and Hermes. Skills load progressively: only the name and description sit in context; the body loads when the agent decides it applies.

### Scopes and inheritance

| Scope | Path | Who can edit |
| --- | --- | --- |
| Global library | `~/.conductor/skills/global/` | Owner; agents may propose |
| Organization | `…/orgs/<org>/skills/` | Owner, lead agents |
| Department | `…/orgs/<org>/depts/<dept>/skills/` | Dept lead agent |
| Agent | `…/agents/<agent>/skills/` | The agent itself |

The skills directory is a git repo. Every change is a commit with author (human or `agent:<id>`) and the run that caused it, so any skill can be diffed and rolled back.

### Agent-authored skills

1. **Detect.** The reflection step flags candidates: a task solved after many steps, a procedure repeated 3+ times, a correction from a human, or a failure that was later fixed.
2. **Draft.** The agent calls the built-in `skill_manage` tool (create / patch / deprecate) to write a skill into its own scope with status `draft`.
3. **Evaluate.** The skill is tested by replaying the originating issue (or a stored eval case) with and without the skill in a sandboxed workspace. Metrics: success, steps, tokens, cost, wall time.
4. **Promote.** If it beats baseline, it becomes `active` for the agent. Lead agents can promote it to department scope; org/global promotion requires owner approval (configurable).
5. **Adapt.** Each use records an outcome. When a skill underperforms (success rate drops, or a human edits its output), the agent patches it; a version that regresses is auto-reverted.
6. **Retire.** Skills unused for 60 days or superseded are marked deprecated and dropped from the index.

### Safety rails

- Skills with `scripts/` run only inside the agent's sandbox (workspace dir, network policy), never with daemon privileges.
- A static scan flags secrets, outbound URLs and shell-escalation patterns in agent-written skills before activation.
- Imported third-party skills (e.g. from skill hubs) are pinned by hash and start as `draft` until reviewed.

## MCP connectors

All tools reach agents through one **Connector Gateway**: a local MCP proxy that every adapter is pointed at. Agents never connect to upstream MCP servers directly, so scoping, approvals, credential injection and audit happen in one place regardless of provider.

### Connector kinds

| Kind | What it is | Auth model |
| --- | --- | --- |
| `mcp_stdio` | Any local MCP server launched as a subprocess (npx, uvx, binary) | Env vars from Keychain |
| `mcp_http` | Any remote MCP server (Streamable HTTP / SSE) | OAuth 2.1 (MCP auth spec) or bearer token |
| `composio` | Composio toolkits (hundreds of SaaS apps) via Composio's MCP endpoint, one Composio *entity* per org or per agent | Composio-managed OAuth per connected account |
| `arcade` | Arcade.dev tools via the Arcade Engine / MCP, with per-user authorization | Arcade just-in-time OAuth; prompts surface as Approvals |
| `builtin` | Conductor's own servers: `conductor-tasks` (issues, comments, goals), `conductor-memory`, `conductor-skills`, `conductor-browser`, `conductor-files` | Run-scoped token |
| `openapi` | Wraps an OpenAPI spec as MCP tools (for APIs without a server) | API key or OAuth |

**Catalog parity with Paperclip.** Paperclip's connector catalog lists Composio, Arcade, Zapier, Make, Honcho, Mem0, Zep, Supermemory, GitHub, Linear, Notion, Slack, Stripe and others. Conductor ships templates for the same set: Zapier and Make via their MCP endpoints; Honcho, Mem0, Zep and Supermemory as optional *external memory backends* as well as tools; GitHub, Linear, Notion, Slack and Stripe via their official MCP servers. Exact parity should be re-checked against Paperclip's catalog before v1.

### Per-agent scoping

- A connector is installed at org or department scope, then **granted** to agents with a tool allowlist (e.g. Gmail: `search`, `read`, `draft` but not `send`).
- Each tool action carries a policy: **Allowed**, **Ask first** (creates an Approval) or **Off**, set per agent, mirroring Paperclip's gateway.
- Credentials are bound per grant: two agents can use the same Composio toolkit with different connected accounts.
- Tool schema hashes are pinned. If an upstream tool changes shape, it is disabled for that agent until re-trusted.
- Every call is logged (agent, run, tool, args hash, result size, latency, cost) and visible on the issue timeline.

### Context budget

Large toolkits are exposed through a two-step pattern: a `find_tools(query)` meta-tool returns matching tool schemas on demand, instead of loading hundreds of schemas into every prompt. Small connectors (< 20 tools) load directly.

## Browser use and remote session sharing

A built-in **Browser Service** gives agents a real Chromium with persistent logins, exposed to every provider as an MCP server (`conductor-browser`) so API and local-CLI agents use it the same way.

### Design

- **Engine.** Playwright-managed Chromium (or the user's installed Chrome via CDP) per **BrowserProfile**. Each profile has its own `user_data_dir`, so cookies, localStorage and logins persist across runs and reboots.
- **Isolation.** Default one profile per agent; a department can share one (e.g. all Sales agents share the LinkedIn login). Profiles never cross orgs.
- **Tools exposed.** `navigate`, `snapshot` (accessibility tree), `click`, `type`, `select`, `screenshot`, `extract`, `download`, `upload`, `tabs`, `evaluate` (policy-gated), plus `request_human(reason)`.
- **Modes.** Headless for routine runs; headed on a virtual display when a human may need to watch or take over.
- **Concurrency.** A profile is leased to one run at a time (Chromium locks the profile dir anyway); the lease is part of the run journal.

### Remote session sharing (human-in-the-loop auth)

When an agent hits a login, MFA, CAPTCHA or consent screen, it calls `request_human`. The flow:

1. The run pauses; the issue moves to `blocked: needs_human` and the owner gets a push (web UI, Telegram/Slack/email gateway).
2. The notification carries a **one-time share link** (signed, 15-minute TTL, single viewer) to a live view of that browser tab, streamed over WebRTC or CDP screencast with input forwarding.
3. The human signs in from any device. The agent is input-locked while the human has control.
4. The human clicks **Hand back**; the session cookies are now in the profile and the run resumes from where it paused.

Remote reach to the Mac uses a user-chosen tunnel (Tailscale recommended; Cloudflare Tunnel optional). Nothing is exposed on a public port by default.

### Credential handling

- Agents never see raw passwords. Credentials live in macOS Keychain or a linked password manager (1Password CLI/Connect); the browser service fills them into a field by reference (`fill_secret(field, secret_ref)`), and transcripts store only the reference.
- Cookie jars are encrypted at rest with a key held in Keychain.
- Per-profile domain allowlists stop an agent from browsing outside its job (e.g. Support agent: helpdesk + docs domains only).
- Purchases, payments, sends and form submissions on sensitive domains trigger an Approval before the click.

## Long-term memory and the learning loop

Memory exists to make an agent do its job the same right way every time, not just to recall chats. So it is typed by what helps the job, and scoped like skills (agent → department → org).

### Memory types

| Type | Holds | Example | Injection |
| --- | --- | --- | --- |
| **Profile** (always-on) | The agent's role card plus a compact `MEMORY.md` of standing rules, ≤ 2k tokens | "Always cc ops@ on vendor emails; brand voice is plain, no exclamation marks." | Every run |
| **Owner model** | Preferences and decisions of the human(s) the org serves (Hermes `USER.md` / Honcho-style) | "Owner rejects designs with stock photos." | Every run, org scope |
| **Procedural** | How-tos that are too small or new to be skills; candidates for promotion | "Stripe dashboard export lives under Reports → Balance." | Retrieved by task similarity |
| **Semantic / entity** | Facts about customers, vendors, systems, repos, with source and timestamp | "Acme Corp: champion is Dana, renewal 2027-03." | Retrieved by entity mention |
| **Episodic** | Summaries of past runs and outcomes, linked to the full transcript | "Run 812: SEO audit; 14 issues filed; 2 rejected as duplicates." | Retrieved by similarity + recency |
| **Lessons** | Distilled mistakes and corrections | "Do not file SEO issues without checking open duplicates." | Retrieved by task type; high priority |

### Storage and retrieval

- SQLite tables with an FTS5 index for keyword search plus `sqlite-vec` embeddings for semantic search; hybrid ranking = similarity × recency decay × importance × confidence (CrewAI-style).
- Every memory keeps `source_run_id`, so a human can trace why an agent believes something.
- Contradictions: on write, near-duplicates are merged and conflicting facts supersede older ones (old kept as history).
- Optional external backends via the same interface: Honcho, Mem0, Zep, Supermemory.
- Agents get `memory_search`, `memory_write`, `memory_forget` tools; owners get a memory browser with edit, pin and delete.

### The learning loop

Every run ends with a reflection pass on the org's utility model:

1. **Outcome grading.** Did the issue close? Was the work accepted, edited or rejected by the reviewer? Cost vs. median for this task type.
2. **Extract.** Propose memories (facts, lessons, preferences) with confidence scores. Low-confidence ones go to a review queue instead of memory.
3. **Skill check.** If the run matches a skill-candidate trigger, open a skill draft (see Skills system).
4. **Consolidate (nightly).** A "dream" job per agent dedupes and compresses memory, rewrites `MEMORY.md` to stay under budget, promotes recurring procedural memories into skill drafts, and decays unused memories.
5. **Weekly review.** Each department lead reviews its agents' scorecards (success rate, rework rate, cost per issue) and proposes prompt, skill or role changes as issues the owner can approve.

**Success signal for "self-improving":** for repeated task types, success rate rises and cost per issue falls over 30 days, shown on each agent's scorecard.

## Governance, budgets and security

The owner is the board. Agents act freely inside policy; anything costly, irreversible or outward-facing goes through an Approval.

### Approvals

Always approval-gated by default: hiring or terminating an agent; raising a budget; any payment or purchase; first send to a new external recipient; publishing public content; granting a new connector or skill to an agent; promoting a skill to org/global scope. Each org can tighten these; loosening below the defaults needs an explicit owner toggle per action type. Approvals arrive in the UI inbox and on messaging gateways with one-tap approve/deny.

### Budgets

- Monthly caps at org, department, agent and project level; the tightest applies.
- Soft alert at 80%, hard stop at 100%: the agent is paused and its in-flight run ends cleanly.
- Spend is metered per run from adapter usage; local-subscription runs are tracked in tokens and counted against a separate "seat time" quota.

### Security model

| Threat | Control |
| --- | --- |
| Secret leakage into prompts or logs | Secrets in Keychain; tools and browser take `secret_ref`, never raw values; log redaction |
| Prompt injection from web pages, emails, tool output | Tool output marked untrusted in context; high-risk tools (send, pay, delete, shell) require Ask-first when the run has ingested untrusted content |
| Agent escaping its scope | Per-run sandbox: workspace dir, macOS sandbox profile or container for shell tools, network allowlist; run-scoped API token with only that agent's permissions |
| Cross-org bleed | `org_id` enforced in every query; separate browser profiles, memory partitions and credential sets |
| Malicious or drifting skills/tools | Hash pinning, static scan, draft-until-reviewed for imports, schema-change quarantine |
| Remote takeover link abuse | Signed single-use links, 15-min TTL, tunnel-only reach, device confirmation |
| Runaway loops | Max steps and wall time per run, max runs per hour per agent, budget hard stop, kill switch per org and global |

Everything is auditable: an append-only activity log records each run, tool call, approval, config change, memory write and skill change, and config changes are revisioned with rollback.

## Interfaces

Every surface is a client of one versioned REST + WebSocket API, so the UI, CLI, gateways and agents themselves use the same contract.

- **Web UI** (served by the daemon at `localhost:7420`, reachable over the tunnel): org switcher; org chart editor; goal tree; issue board and timeline; agent pages with config, skills, connectors, memory browser, scorecard and run transcripts; approvals inbox; cost dashboard; live browser viewer for takeovers.
- **CLI** (`conductor`): `install`, `org create --template`, `agent hire`, `issue create`, `run now`, `logs -f`, `skills diff/rollback`, `memory search`, `doctor` (checks launchd, Keychain, provider logins, tunnel).
- **Messaging gateways** (Hermes-style): Telegram, Slack, Discord, iMessage (via local bridge) and email. Chat with any agent, get approvals and the morning digest, receive takeover links.
- **Agent-facing API:** exposed to agents as the `conductor-tasks` MCP server (create/update issues, comment, delegate, request approval, report progress), plus a run-scoped HTTP token for `process`/`http` adapters.
- **Webhooks in/out:** inbound triggers (GitHub, Stripe, Composio triggers) wake agents; outbound events (issue done, approval requested) for external automation.
- **Import / export:** an org can be exported as a portable bundle (org chart, agent configs, skills, sanitized memory; never secrets) and imported as a template.

## Tech stack and storage

TypeScript end to end, one process, one SQLite file per install. This keeps a single-owner, always-on Mac install simple to run, back up and debug; Postgres is a later option, not a v1 dependency.

| Layer | Choice | Why |
| --- | --- | --- |
| Daemon | Node.js 22 LTS, TypeScript, Fastify (HTTP + WS) | Official MCP TypeScript SDK; Paperclip-compatible adapter ecosystem |
| Database | SQLite (WAL) via Drizzle ORM; FTS5 + `sqlite-vec` | Zero-ops, single file, fast enough for one owner; hybrid search in-process |
| Job scheduling | In-process scheduler on DB-backed job table (cron + event queue) | Survives restarts without Redis |
| Run isolation | Child processes per run; `sandbox-exec` profile or Docker/Apple container for shell tools | Crash containment, filesystem and network limits |
| Browser | Playwright + Chromium, CDP screencast / WebRTC for takeover | Persistent profiles, mature automation |
| Secrets | macOS Keychain (`security` / keytar); optional 1Password CLI | OS-grade storage, never in the DB |
| UI | React + Vite, served by the daemon | Single install, no separate server |
| Remote access | Tailscale (recommended) or Cloudflare Tunnel | No open ports |
| Packaging | Signed `.pkg` / Homebrew formula installing binary + LaunchAgent | Native macOS install and updates |

### On-disk layout

```text
~/.conductor/
  conductor.db              # all structured state
  adapters/                 # provider adapter plugins
  skills/global/            # git repo
  orgs/<org-slug>/
    skills/  depts/<dept>/skills/
    agents/<agent-slug>/
      MEMORY.md  skills/  workspace/
    browser-profiles/<profile>/   # encrypted cookie jar
    artifacts/  transcripts/
~/Library/LaunchAgents/ai.conductor.daemon.plist
~/Library/Logs/Conductor/
```

Backups: nightly `VACUUM INTO` snapshot plus the git-backed skills; Time Machine friendly. Known ceiling: a single SQLite writer caps throughput around a few hundred runs/hour, plenty for one owner; move to Postgres if multi-machine workers arrive.

## Requirements

### Functional requirements

| ID | Requirement | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| FR-1 | Daemon auto-starts via launchd and self-heals | P0 | After reboot + login, UI reachable in < 30 s; killed process restarts in < 15 s; in-flight runs resumed or released |
| FR-2 | Create, edit, archive multiple organizations | P0 | 3+ orgs run concurrently with zero cross-org data in queries, memory or browser profiles (verified by test) |
| FR-3 | Departments and agents with org chart | P0 | Create dept, hire agent, set reports\_to; chart renders; delegation respects lines |
| FR-4 | Goals → issues with atomic checkout | P0 | 50 parallel checkout attempts on one issue yield exactly one owner |
| FR-5 | Heartbeat + event triggers | P0 | Per-agent cron honored within ±1 min; assignment/mention wakes agent in < 10 s |
| FR-6 | Provider adapters: `openai_api`, `claude_api`, `claude_local`, `codex_local` | P0 | Same reference issue completes on all four; usage and cost recorded |
| FR-7 | Adapter plugin SDK + `process` / `http` adapters | P1 | Third-party adapter installs without core changes |
| FR-8 | Per-agent skills with scope inheritance | P0 | Effective skill set snapshotted per run; agent sees only its own + inherited |
| FR-9 | Agent-authored skills with eval gate and versioning | P0 | Agent creates, tests, activates and patches a skill; owner can diff and roll back |
| FR-10 | Connector gateway: stdio/HTTP MCP, Composio, Arcade | P0 | Agent A can call a granted tool; agent B without grant cannot; Ask-first raises an Approval |
| FR-11 | Catalog templates for Paperclip-parity connectors | P1 | Zapier, Make, GitHub, Linear, Notion, Slack, Stripe, Honcho, Mem0, Zep, Supermemory install from templates |
| FR-12 | Browser service with persistent profiles | P0 | Login survives daemon restart and reboot |
| FR-13 | Remote takeover for auth | P0 | From a phone over Tailscale, human completes MFA and hands back; run resumes without re-login |
| FR-14 | Typed long-term memory with hybrid search | P0 | Memory written in run N is retrieved in run N+1 on a related issue; owner can edit/delete |
| FR-15 | Learning loop: reflection, nightly consolidation, scorecards | P1 | Scorecard shows success rate and cost per issue trend per agent |
| FR-16 | Approvals, budgets, kill switches | P0 | Hard stop pauses agent at 100% of cap; approvals actionable from UI and Telegram |
| FR-17 | Messaging gateways (Telegram, Slack first) | P1 | Chat with agent, receive digest, approve from chat |
| FR-18 | Org templates + import/export | P1 | Export then import recreates org with no secrets in bundle |

### Non-functional requirements

- **Reliability:** daemon uptime ≥ 99.5% while the Mac is awake; no lost issue state across crashes (journaled writes).
- **Performance:** UI p95 < 200 ms for boards up to 5k issues; scheduler overhead < 2% CPU idle.
- **Footprint:** idle daemon < 300 MB RAM, excluding active browsers and agent CLIs.
- **Security:** no secret ever persisted outside Keychain/vault; all remote access authenticated; audit log append-only.
- **Portability:** core is OS-neutral; only service install and Keychain are macOS-specific, behind interfaces.
- **Observability:** every run has a transcript, cost, tool log and outcome; OpenTelemetry export optional.

### Success metrics (90 days after launch)

- Owner time-to-first-autonomous-issue-closed < 15 min from install.
- ≥ 70% of agent-closed issues accepted without rework.
- Cost per issue on repeated task types down ≥ 25% between week 1 and week 8 per agent.
- < 1 owner intervention per 20 runs, excluding approvals.

## Milestones

Build in four phases. Each phase ends only when its gate scenario works end to end on a real Mac.

&#91;embedded content: Roadmap · 4 phases, 4 gates\]

Phase 1 uses the local CLIs first because they reuse existing subscriptions and already have tool loops. That lets the control plane be proven before Conductor owns an agent loop. Durations are deliberately unset until team size is known.

## Open questions

- [ ] **Name.** Is "Conductor" a working name only? Check trademark before any public release.
- [ ] **Paperclip compatibility.** Should Conductor read and write Paperclip's adapter and skill formats so agents and orgs can move between the two?
- [ ] **Boot without login.** Is the headless LaunchDaemon mode (no Keychain, no GUI browser) needed for v1, or is login-required acceptable?
- [ ] **Composio vs Arcade default.** Which is the default toolkit source when both offer the same app, given different auth and pricing models?
- [ ] **Subscription terms.** Confirm that unattended, scheduled use of Claude Code and Codex logins is within each provider's terms; otherwise default to API keys for always-on agents.
- [ ] **Skill promotion policy.** Should promotion to department scope be automatic on eval win, or always lead-reviewed?
- [ ] **Multi-machine.** Is a second Mac (or cloud worker) running agents for the same orgs in scope before v2? If so, revisit SQLite.

## Sources

- [Paperclip repository](https://github.com/paperclipai/paperclip) and [adapter reference](https://docs.paperclip.ing/reference/adapters/overview), [tool gateway](https://docs.paperclip.ing/reference/api/tool-gateway/)
- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent)
- [CrewAI docs: agents](https://docs.crewai.com/en/concepts/agents), [processes](https://docs.crewai.com/en/concepts/processes), [memory](https://docs.crewai.com/en/concepts/memory)
