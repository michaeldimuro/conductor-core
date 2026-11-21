# Conductor

**Run organizations of AI agents on your own Mac.**

Conductor is a local-first, always-on agent orchestration harness for macOS. It runs as a launchd daemon, models work as **organizations → departments → agents**, and drives agents toward goals through a ticket-and-heartbeat loop. Each agent has its own skills, MCP connectors, model provider, browser profile, budget and long-term memory, and it gets better at its job over time.

You set the goals and approve the risky actions. The agents do the work: overnight, across several ventures, within budget, and they only ask you when a decision really is yours.

```text
Owner (you, the board)
 └─ Organization ─ mission, goals, budget, policies
     └─ Department ─ charter, lead agent, shared skills & connectors
         └─ Agent ─ role · goal · backstory · provider · skills · connectors · memory · browser · budget
             └─ Issue ─ checked out atomically, worked on a heartbeat, reported, reflected on
```

---

## Contents

- [Why Conductor](#why-conductor)
- [Features](#features)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Architecture](#architecture)
- [Provider adapters](#provider-adapters)
- [Skills](#skills)
- [Memory and the learning loop](#memory-and-the-learning-loop)
- [Connectors (MCP)](#connectors-mcp)
- [Browser and human takeover](#browser-and-human-takeover)
- [Governance, budgets and safety](#governance-budgets-and-safety)
- [Interfaces](#interfaces)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Data on disk](#data-on-disk)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Further documentation](#further-documentation)
- [License](#license)

---

## Why Conductor

Existing tools each cover one part of the problem:

- **Paperclip** models a company and governs agents, but leaves learning and memory to each agent runtime.
- **Hermes Agent** learns and writes its own skills, but it is a single agent, not an organization.
- **CrewAI** composes role-based crews, but runs as a script rather than a persistent workforce.

Conductor puts these together in one always-on runtime: Paperclip's org model and governance, Hermes's closed learning loop, and CrewAI's agent personas and processes. On top of that it adds a launchd-native daemon, human-takeover browser sessions for logins and MFA, eval-gated skill changes, and memory designed to keep an agent's work consistent rather than to recall chats.

The primary user is a solo founder or operator who runs several ventures from one Mac and wants agents doing real work while they sleep.

## Features

| Area | What you get |
| --- | --- |
| **Always on** | A launchd LaunchAgent starts the daemon at login and restarts it after a crash. In-flight runs are journaled, so after a restart they are resumed or released back to the queue. An optional headless LaunchDaemon starts it at boot without a login. |
| **Many organizations** | Each organization is a hard isolation boundary: agents, memory, secrets, browser profiles and budgets never cross orgs. Start blank or from a template (`saas-startup`, `agency`, `content-studio`, `solo-operator`). |
| **Org chart** | Departments, lead agents and reporting lines. Work is delegated down the chart, escalations go up it, and the owner sits at the root. |
| **Goal-driven work** | A goal tree (org → department → agent), with issues linked to goals. Issues have parents, blockers, comments and atomic checkout, so no two agents ever work the same issue. |
| **Any provider** | Built-in `claude_local` (Claude Code), `codex_local` (Codex CLI), `claude_api`, `openai_api`, `process` and `http` adapters, fallback chains, and a plugin SDK for adding more. |
| **Self-authored skills** | Agents create, revise, evaluate, promote and retire their own `SKILL.md` procedures. Every change is a git commit you can diff and roll back. |
| **Long-term memory** | Typed memories (profile, owner model, procedural, entity, episodic, lessons), hybrid FTS5 + vector search, a nightly "dream" consolidation and per-agent scorecards. |
| **Connector gateway** | One local MCP proxy for every tool. Grants are per agent, each tool action is set to Allowed, Ask first or Off, tool schemas are pinned, and every call is audited. The catalog has 80+ templates. |
| **Real browser** | Playwright Chromium with persistent per-agent profiles, domain allowlists, credential filling by reference (Keychain or 1Password), and one-time links that let a human take over the browser from a phone. |
| **Governance** | Approvals for hires, spend, first sends and publishing. Budgets at org, department, agent and project level with an 80% alert and a 100% hard stop. Kill switches per org and global. Revisioned config with rollback. An append-only audit log. |
| **Reach you anywhere** | A web UI that also works on a phone, a full CLI, and messaging gateways for Telegram, Slack, Discord, iMessage and email, plus inbound and outbound webhooks. |
| **Portable orgs** | Export an organization as a bundle (org chart, agent configs, skills, sanitized memory, never secrets) and import it elsewhere as a template. |

## Quick start

### Requirements

- macOS (launchd packaging; the core itself does not depend on the OS)
- Node.js **22** or newer
- `git` (skills are versioned with it)
- At least one provider: a logged-in `claude` or `codex` CLI, or an Anthropic or OpenAI API key
- Optional: Playwright Chromium for browser use (`conductor doctor` prints the install command)
- Optional: Tailscale or Cloudflare Tunnel to reach Conductor from your phone

### Install

Install from the `.pkg` installer or the Homebrew formula (see [docs/install.md](docs/install.md)), or run it from source:

```sh
git clone https://github.com/michaeldimuro/conductor-core.git
cd conductor-core
npm install
npm run build
npm link            # puts `conductor` and `conductord` on your PATH
```

### First run

```sh
conductor install      # write and load the LaunchAgent; waits until the daemon answers
conductor doctor       # check launchd, daemon, Keychain, provider logins, browser, tunnel
conductor quickstart   # first organization, first goal, first issue
conductor open         # sign in to the web UI at http://127.0.0.1:7420
```

> **Heads-up:** `quickstart` starts real work as soon as the organization exists, and that spends provider quota. Use `conductor quickstart --no-run` to set everything up without starting a run. `conductor org kill` stops one organization and `conductor kill-switch on` stops everything.

A slightly more explicit first organization:

```sh
conductor quickstart \
  --name "Acme" \
  --template saas-startup \
  --mission "Ship a small, profitable developer tool" \
  --provider claude_local \
  --goal "Launch a public beta" \
  --issue "Draft the launch plan"
```

Then watch it work:

```sh
conductor status           # what the daemon is doing
conductor issue list       # open work
conductor logs -f          # daemon log
conductor approvals list   # anything waiting on you
```

## Core concepts

Everything is scoped by organization.

| Entity | What it is |
| --- | --- |
| **Organization** | Top-level tenant with a mission, monthly budget, default provider and policies. |
| **Department** | A group of agents with a charter, a lead agent, a budget, and skills and connectors its members inherit. |
| **Agent** | A CrewAI-style persona (`role`, `goal`, `backstory`) plus an employee record: reports-to, provider binding, model, heartbeat cron, budget, autonomy level, skills, connectors and browser profile. |
| **Goal** | A node in the goal tree, with a success metric, target and due date. Every issue traces back to a goal. |
| **Project** | Optional grouping of issues under a goal. It owns a workspace directory and can carry its own budget. |
| **Issue** | The unit of work: `backlog → todo → in_progress → in_review → done`, plus `blocked` and `cancelled`. Issues have parents, blockers, labels, comments and attachments. |
| **Run** | One heartbeat execution of one agent. It stores the full transcript, a snapshot of the agent's capabilities, token usage, cost and outcome. |
| **Playbook** | A reusable multi-step process (sequential or manager-delegated) that runs inside an issue. |
| **Approval** | A gated action waiting for the owner, such as a hire, budget raise, payment, first external send or publish. |

**Capability resolution.** An agent's effective skills and connectors are `org defaults ∪ department shared ∪ agent own`, minus anything explicitly denied. They are resolved at the start of each run and snapshotted onto the run for audit.

### The heartbeat loop

Agents wake on a **heartbeat** (a cron schedule per agent) or on an **event**: an issue assigned to them, an @mention in a comment, an approval decided, an inbound webhook, a message from a gateway, or "run now". Concurrency is limited per org, per provider and globally.

1. **Wake and resolve.** Load the agent's config and snapshot its skills, connectors and remaining budget. Stop if it is over budget or paused.
2. **Recall.** Load the memory snapshot, relevant long-term memories and the skill index.
3. **Inbox.** Read assigned issues, new comments and mentions, ordered by priority and goal weight.
4. **Checkout.** Atomically claim one issue. An agent that loses the race moves on.
5. **Plan.** Split large issues into child issues delegated down the chart; otherwise plan the steps.
6. **Execute.** Hand the run to the provider adapter. Tool calls go through the connector gateway and browser actions through the browser service.
7. **Report.** Comment with results and artifacts, update the status (`done`, `in_review`, or `blocked` with a reason) and record the cost.
8. **Reflect.** Write memories and let the skill curator decide whether to create or revise a skill.

A stale-work sweep nudges idle issues and then escalates them up the reporting line. A morning digest and the **Needs you** view show only what is actually waiting on the owner.

### Autonomy levels

| Level | Behavior |
| --- | --- |
| **0 · Assist** | Acts only on explicitly assigned issues. Every external action needs approval. |
| **1 · Supervised** | Creates its own sub-issues and does routine work on its own. Destructive actions, payments, publishing and first sends need approval. |
| **2 · Autonomous** | Pursues goals proactively within budget and policy. Only policy-flagged actions need approval. |
| **3 · Lead** | Level 2, plus it may propose hires, reassign work and set department goals. Hires are still approved by the board. |

## Architecture

A single daemon, `conductord`, is the control plane. Agents never talk to models, tools or websites directly. Every call goes through an adapter, the connector gateway or the browser service, and that is where scoping, approvals, cost metering and audit are enforced for every provider.

```text
 ┌──────────────── Clients ────────────────┐
 │  Web UI   CLI   Gateways   Webhooks      │   one versioned REST + WebSocket API
 └───────────────────┬─────────────────────┘
                     ▼
 ┌──────────────────────────── conductord ────────────────────────────┐
 │  Org & work model   Scheduler & triggers   Governance   Learning    │  what runs, when
 │  ─────────────────────────────────────────────────────────────────  │
 │  Provider adapters  Connector gateway (MCP)  Browser service  Memory │  how a run reaches the world
 │                        SQLite (WAL) · FTS5 · sqlite-vec · git skills │
 └───────┬──────────────────────┬────────────────────┬─────────────────┘
         ▼                      ▼                    ▼
   Claude / Codex /       MCP servers, Composio,   Chromium profiles
   OpenAI / plugins       Arcade, SaaS APIs        (human takeover)
```

| Layer | Choice |
| --- | --- |
| Daemon | Node.js 22, TypeScript (ESM), Fastify (HTTP + WebSocket) |
| Database | SQLite (WAL) via Drizzle ORM, FTS5 plus `sqlite-vec` for hybrid search |
| Scheduling | In-process scheduler on a DB-backed job table (cron plus event queue) that survives restarts |
| Run isolation | Supervised child processes and a macOS `sandbox-exec` profile for spawned CLIs |
| Tools | Official MCP TypeScript SDK; a local gateway proxies every upstream server |
| Browser | Playwright and Chromium, CDP screencast for live takeover |
| Secrets | macOS Keychain (or an AES-256-GCM file vault in headless mode); optional 1Password |
| UI | React 19, Vite and React Router, served by the daemon |
| Observability | Pino logs, per-run transcripts, optional OpenTelemetry export |

## Provider adapters

Every provider sits behind one `AgentAdapter` contract, and run events (text, tool calls, results, usage, errors) are normalized. The UI, the cost ledger and the learning loop therefore work the same whichever provider ran.

| Adapter | Transport | Auth | Session resume | Cost |
| --- | --- | --- | --- | --- |
| `claude_local` | `claude -p --output-format stream-json` | Your Claude Code login, a stored long-lived token, or an API key | `--resume <session>` | Subscription runs are flagged $0 marginal and tracked as seat time |
| `codex_local` | `codex exec --json` | Your ChatGPT/Codex login or a key | Codex session id | Reported usage |
| `claude_api` | Anthropic Messages API (Conductor owns the loop) | API key in Keychain | Conductor transcript | Tokens × price table |
| `openai_api` | OpenAI Responses API (Conductor owns the loop) | API key in Keychain | Conductor transcript | Tokens × price table |
| `process` | Runs any command | — | — | Reported |
| `http` | Calls any webhook | — | — | Reported |

- **Fallback chains.** Give an agent a primary binding and fallbacks (for example `claude_local → claude_api → openai_api`). A fallback is used on rate limits, auth failures and outages.
- **Utility model.** A cheaper model per org handles reflection, summaries, memory extraction and skill judging (`conductor memory utility-model`).
- **Plugins.** Drop a folder with a `conductor-adapter.json` manifest into `~/.conductor/adapters/`. It is hot-loaded with no restart and builds on `conductor/adapters/sdk`. See [docs/adapter-plugins.md](docs/adapter-plugins.md) and [`examples/adapters/echo-adapter`](examples/adapters/echo-adapter).

```sh
conductor adapter list
conductor adapter models claude_api
conductor adapter test claude_local
conductor auth --help             # log Conductor in to Claude Code / Codex, store long-lived tokens
```

## Skills

A skill is a folder with a `SKILL.md` (YAML front matter plus instructions) and optional `scripts/`, `references/` and `assets/`, in the open Agent Skills format used by Claude Code, Codex and Hermes. Skills load progressively: only the name and description sit in context until the agent decides a skill applies.

| Scope | Edited by |
| --- | --- |
| Global library | Owner only (it spans every org) |
| Organization | Owner and lead agents |
| Department | The department lead |
| Agent | The agent itself |

The skills directory is a git repository. Every change is a commit attributed to a human or to `agent:<id>` and to the run that caused it.

**The agent-owned lifecycle.** No skill change waits for the owner.

1. **Curate.** After each run, the agent's skill curator weighs the transcript, the agent's memory and its existing skills, then decides `none` (the usual answer), `create` or `revise`.
2. **Create** only when a kind of task has succeeded three or more times, has several real steps and isn't covered by an existing skill.
3. **Revise** only when what the agent actually did beat the skill it used. Cosmetic rewrites are refused.
4. **Evaluate.** New skills and revisions are replayed with and without the change in a sandbox, comparing success, steps, tokens, cost and wall time. A clear loss stays out.
5. **Adapt.** A version that regresses is reverted automatically.
6. **Promote** to department or org scope, either by the agent or lead, or automatically on an eval win with `deptSkillPromotion: 'auto'`.
7. **Consolidate.** Nightly, overlapping skills are merged, id-named skills are renamed and one-off write-ups are retired.

**Safety rails.** Scripts run only inside the agent's sandbox. A static scan catches secrets, outbound URLs and shell-escalation patterns, and a skill that fails the scan is quarantined until it is patched. Imported skills are pinned by hash and start as drafts.

```sh
conductor skills list
conductor skills diff <skill>
conductor skills rollback <skill> <version>
conductor skills evaluate <skill>
conductor skills consolidate --dry-run
conductor skills import ./my-skill
```

## Memory and the learning loop

Memory exists to make an agent do its job the same right way every time. It is typed by what helps the job, and scoped agent → department → org.

| Type | Holds | Injected |
| --- | --- | --- |
| **Profile** | The role card plus the `MEMORY.md` snapshot (standing rules and distilled lessons), up to about 3k tokens | Every run |
| **Owner model** | Your preferences and decisions (`USER.md`) | Every run, org scope |
| **Procedural** | How-tos too small or too new to be skills | By task similarity |
| **Semantic / entity** | Facts about customers, vendors, systems and repos, with source and time | By entity mention |
| **Episodic** | Summaries of past runs, linked to full transcripts | By similarity and recency |
| **Lessons** | Distilled mistakes and corrections | By task type, high priority |

- **Hybrid retrieval.** Results are ranked by similarity × recency decay × importance × confidence, using FTS5 keyword search and `sqlite-vec` embeddings.
- **Traceable.** Every memory keeps the run it came from. Near-duplicates are merged, and a conflicting fact supersedes the older one, which is kept as history.
- **Nothing is forgotten by disuse.** Idle memories rank lower but stay searchable. Run transcripts are never pruned, and agents can search and re-read their own past runs.
- **Nightly "dream" job.** Each night, memory is deduplicated and compressed, `MEMORY.md` is rebuilt and recurring procedures are handed to the skill curator.
- **Scorecards.** Each agent has a scorecard tracking success rate, rework rate and cost per issue over time.
- **External backends** (optional): Honcho, Mem0, Zep and Supermemory. Local memory always stays on.

```sh
conductor memory search "vendor onboarding" --agent <agent>
conductor memory edit <id>
conductor memory pin <id>
conductor memory owner-model --edit
conductor agent scorecard <agent>
```

## Connectors (MCP)

All tools reach agents through one **connector gateway**, a local MCP proxy that every adapter is pointed at. Agents never connect to upstream servers directly.

**Kinds:** `mcp_stdio` (local servers), `mcp_http` (remote servers with OAuth 2.1 or a bearer token), `composio`, `arcade`, `openapi`, and the built-in servers (`conductor-tasks`, `conductor-memory`, `conductor-skills`, `conductor-browser`, `conductor-files`).

**Scoping.** A connector is installed at org or department scope and then **granted** to individual agents with a tool allowlist. Every action carries a policy of **Allowed**, **Ask first** (raises an approval) or **Off**. Credentials are bound per grant. Tool schema hashes are pinned, so a tool whose schema changes upstream is disabled until you re-trust it. Large toolkits are exposed through a `find_tools` meta-tool so they don't flood the context.

**Catalog** (`conductor connector catalog`) includes templates for GitHub, Linear, Jira, Confluence, Notion, Slack, Discord, Telegram, Google Workspace, Microsoft 365, Stripe, PayPal, Square, Shopify, HubSpot, Attio, Intercom, Airtable, Asana, ClickUp, Monday, Todoist, Figma, Canva, Webflow, Sentry, Datadog, PostHog, Supabase, Neon, Postgres, MongoDB, Prisma, Cloudflare, Netlify, Render, Heroku, Pinecone, Hugging Face, Replicate, ElevenLabs, Perplexity, Exa, Tavily, Brave Search, Firecrawl, Apify, Playwright, Zapier, Make, n8n, Composio, Arcade, Honcho, Mem0, Zep, Supermemory and more.

```sh
conductor connector catalog
conductor connector install github
conductor connector grant github <agent>       # with per-tool policies
conductor connector tools github
conductor connector retrust github <tool>
```

## Browser and human takeover

A built-in **browser service** gives every agent a real Chromium with persistent logins, exposed as the `conductor-browser` MCP server so that API agents and local-CLI agents use it the same way.

- **Profiles.** By default each agent gets its own profile; a department can share one. Profiles never cross orgs, and cookie jars are encrypted at rest.
- **Engines.** Bundled Playwright Chromium, your installed Chrome, or a running Chrome over CDP. Windows can be headless or headed.
- **Tools.** Navigate, snapshot, click, type, select, screenshot, extract, download, upload, tabs, policy-gated evaluate, `fill_secret`, and `request_human`.
- **Credentials.** Agents never see raw passwords. Secrets are filled into fields by reference from Keychain or 1Password.
- **Guard rails.** Per-profile domain allowlists. Payments, sends and form submissions on sensitive domains require an approval before the click.

**Human takeover.** When an agent hits a login, MFA, CAPTCHA or consent screen, it calls `request_human`. The issue becomes blocked, you get a notification with a **one-time share link** (signed, 15-minute TTL, single viewer) to a live view of the tab, and you complete the step from any device. While you have control, the agent's input is locked. When you click **Hand back**, the run resumes with the new session saved in the profile. Remote reach goes through your own tunnel (Tailscale recommended); nothing is exposed on a public port by default.

```sh
conductor browser profiles
conductor browser takeovers
conductor browser takeover <session>    # mint a fresh link
conductor pair                          # one-time login link for your phone
```

## Governance, budgets and safety

**Approvals.** These are gated by default: hiring or terminating agents, raising budgets, any payment or purchase, the first send to a new external recipient, publishing public content, and granting a new connector. Skills are not gated by default (opt in with `extraGated: ['grant_skill', 'promote_skill']`). Approvals can be acted on from the web UI, the CLI and the messaging gateways.

**Budgets.** Monthly caps can be set at org, department, agent and project level, and the tightest one applies. You get an alert at 80%. At 100% the agent is paused and its in-flight run ends cleanly. Local-subscription runs are counted as seat time.

**Security model.**

| Threat | Control |
| --- | --- |
| Secret leakage | Secrets live in Keychain or the vault, never in the database. Tools take `secret_ref`. Secret values are masked in every emitted event. |
| Prompt injection | Tool output is marked untrusted. High-risk actions after ingesting untrusted content need Ask first. |
| Scope escape | Each run gets a workspace, a macOS sandbox profile (credential paths and the Conductor home are denied), a network policy and a run-scoped API token. |
| Cross-org bleed | `org_id` is enforced in every query, with separate browser profiles, memory partitions and credentials per org. |
| Drifting tools and skills | Hash pinning, static scans, draft-until-reviewed imports, and schema-change quarantine. |
| Runaway loops | Max steps and wall time per run, run-rate limits, budget hard stops, and kill switches per org and global. |

Everything is auditable. An append-only activity log records every run, tool call, approval, config change, memory write and skill change. Configuration is revisioned with rollback (`conductor revisions`).

## Interfaces

All surfaces are clients of the same versioned **REST + WebSocket API**.

- **Web UI** at `http://127.0.0.1:7420`, built for both desktop and phone. Pages include overview, the **Needs you** inbox, goals, issue board and tree, issue detail, org chart, team and agent pages (config, skills, connectors, memory, scorecard, transcripts), approvals, costs, connectors, skills, artifacts, activity, run viewer, live takeover viewer, and settings (providers, accounts, reach, playbooks).
- **CLI** (`conductor`). The full surface is described below.
- **Messaging gateways.** Telegram, Slack (including Socket Mode), Discord, iMessage (through a local bridge) and email (IMAP/SMTP). Chat with any agent, get approvals and the morning digest, and receive takeover links. Pair a chat with `conductor gateway pair`.
- **Agent-facing API.** The `conductor-tasks` MCP server lets agents create and update issues, comment, delegate, request approval and report progress. `process` and `http` adapters get a run-scoped HTTP token.
- **Webhooks.** Inbound webhooks (GitHub, Stripe, Composio triggers and others) wake agents. Outbound webhooks send events such as "issue done" or "approval requested" to external systems.

## CLI reference

Global options: `--json`, `--home <dir>`, `--url <base>` and `--org <slug|id>`. Run `conductor <command> --help` for full details.

| Command | Purpose |
| --- | --- |
| `install` · `uninstall` · `restart` · `status` | Manage the launchd agent and the daemon (`install --headless` prints a boot-time LaunchDaemon setup) |
| `open` · `pair` | Sign in to the web UI; get a one-time login link for another device |
| `quickstart` | From a running daemon to a first autonomous issue in one command |
| `doctor` | Check launchd, daemon, Keychain, provider logins, browser and tunnel |
| `org` | `list` `create` `use` `show` `archive` `templates` `export` `import` `kill` `unkill` |
| `dept` | `list` `create` `archive` `unarchive` |
| `agent` | `list` `hire` `show` `update` `pause` `resume` `terminate` `chart` `scorecard` `chat` |
| `goal` | `list` `create` `delete` `tree` |
| `project` | Workspaces and budgets that group issues under a goal |
| `issue` | `list` `create` `show` `comment` `assign` `review` `artifacts` |
| `playbook` | `list` `update` `delete` |
| `run` | `now` `list` `show` `cancel` |
| `logs` | Daemon logs, or a run transcript with `--run` / `--agent` |
| `approvals` | `list` `show` `approve` `deny` |
| `budget` · `kill-switch` | Spend against caps; global stop (`on` / `off`) |
| `skills` | `list` `show` `diff` `history` `rollback` `evaluate` `eval-cases` `activate` `promote` `consolidate` `import` `delete` |
| `memory` | `search` `list` `show` `edit` `pin` `forget` `owner-model` `backend` `embedder` `utility-model` |
| `connector` | `catalog` `list` `install` `grant` `revoke` `tools` `retrust` `remove` |
| `browser` | `profiles` `profile-create` `profile-set` `takeovers` `takeover` |
| `gateway` | `list` `add` `pair` `status` `remove` |
| `webhook` | `list` `add in\|out` `remove` |
| `adapter` | `list` `models` `test` `rescan` |
| `auth` | Log Conductor in to Claude Code and Codex; store long-lived tokens |
| `secret` | `set` `has` `delete` (write-only: values are never read back) |
| `config` | `get` `set` daemon settings |
| `revisions` | `list` `show` `rollback` for any configured entity |

## Configuration

Most settings live in the daemon (`conductor config get` / `conductor config set`) and in per-org policies. The following environment variables affect the daemon and the CLI:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CONDUCTOR_HOME` | Data directory | `~/.conductor` |
| `CONDUCTOR_PORT` | API and UI port | `7420` |
| `CONDUCTOR_HOST` | Bind address | `127.0.0.1` |
| `CONDUCTOR_PUBLIC_URL` | Public URL used in share and login links (for example your Tailscale name) | — |
| `CONDUCTOR_LOG_DIR` | Log directory | `~/Library/Logs/Conductor` |
| `CONDUCTOR_LOG_LEVEL` | Pino log level | `info` |
| `CONDUCTOR_SECRETS` | Secret store: Keychain, or `vault` for headless mode | Keychain |
| `CONDUCTOR_VAULT_KEY` / `CONDUCTOR_VAULT_KEY_FILE` | Vault passphrase, or the file that holds it | — |
| `CONDUCTOR_OP_BIN` | Path to the 1Password CLI | `op` on `PATH` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | Optional OpenTelemetry export | — |

The CLI authenticates with `~/.conductor/owner.token` (mode 0600). Anyone who can read that file can control Conductor.

## Data on disk

```text
~/.conductor/
  conductor.db               # all structured state (SQLite, WAL)
  owner.token                # CLI credential (0600)
  adapters/                  # provider adapter plugins (hot-loaded)
  skills/global/             # git-versioned skill library
  orgs/<org>/
    skills/  depts/<dept>/skills/
    agents/<agent>/          # MEMORY.md, skills/, workspace/
    browser-profiles/        # encrypted cookie jars
    artifacts/  transcripts/
  backups/                   # nightly VACUUM INTO snapshots
~/Library/LaunchAgents/ai.conductor.daemon.plist
~/Library/Logs/Conductor/
```

Database migrations run automatically when the daemon starts. Upgrades never touch your data.

## Development

```sh
npm install

npm run dev          # run the daemon from source (tsx, --serve)
npm run dev:ui       # Vite dev server for the web UI

npm run build        # tsc + asset copy + UI build into dist/ and ui/dist/
npm run typecheck    # strict type check of src and tests
npm run lint         # ESLint
npm test             # Vitest suite

npm run db:generate  # generate a Drizzle migration after schema changes
```

The test suite under `tests/` covers each bounded context (adapters, API, browser, CLI, connectors, daemon, gateways, governance, kernel, memory, org, runtime, skills, work, UI) along with end-to-end and phone-workflow UI tests.

Packaging for distribution (maintainers):

```sh
npm run build
npm run package:pkg -- --out <dir> --sign "Developer ID Installer: <name> (<team id>)"
npm run package:formula -- --out <dir> --url-base <release-url>
```

See [docs/install.md](docs/install.md#building-the-packages-maintainers) for details on signing, bundling Node and publishing the formula.

## Repository layout

```text
bin/                 conductor and conductord entry points
config/              tsconfig, ESLint, Vitest and Drizzle configs
docs/                install, headless mode, adapter plugin guides
examples/adapters/   a complete example adapter plugin
packaging/           .pkg and Homebrew templates and installer scripts
scripts/             build, asset copy and packaging scripts
spec/prd.md          architecture & product requirements
src/
  adapters/          provider adapters, plugin registry, SDK, pricing, fallback chains
  api/               Fastify REST + WebSocket server, routes, auth, webhooks, takeover
  browser/           Playwright engine, profiles, tools, takeover viewer, 1Password
  cli/               the `conductor` CLI
  connectors/        MCP gateway, catalog templates, grants, policies, OAuth, pins
  contracts/         typed interfaces shared across bounded contexts
  daemon/            composition root, launchd integration, lifecycle, plugin watcher
  db/                Drizzle schema and migrations
  gateways/          Telegram, Slack, Discord, iMessage, email
  governance/        approvals, budgets, kill switches, policy, run tokens
  kernel/            audit log and secret storage
  memory/            typed memory, hybrid recall, reflection, consolidation, scorecards
  org/               orgs, departments, agents, org chart, templates, import/export
  runtime/           scheduler, triggers, worker, supervisor, journal, recovery
  shared/            ids, paths, events, errors
  skills/            skill store, authoring, eval gate, promotion, scanning, git
  work/              goals, projects, issues, checkout, comments, playbooks, inbox
tests/               Vitest suites mirroring src/
ui/                  React + Vite web UI
```

## Further documentation

- [docs/install.md](docs/install.md): installing, upgrading and removing Conductor, and building the packages
- [docs/headless.md](docs/headless.md): starting at boot without a login (LaunchDaemon and encrypted vault)
- [docs/adapter-plugins.md](docs/adapter-plugins.md): writing a provider adapter plugin
- [spec/prd.md](spec/prd.md): the full architecture and product requirements

## License

Proprietary. All rights reserved. This package is marked `UNLICENSED` and is not licensed for redistribution.
