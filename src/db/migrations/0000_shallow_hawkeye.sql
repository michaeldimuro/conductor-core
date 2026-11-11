CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`dept_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`backstory` text DEFAULT '' NOT NULL,
	`reports_to` text,
	`provider_binding` text,
	`model` text,
	`skills` text DEFAULT '[]' NOT NULL,
	`connectors` text DEFAULT '[]' NOT NULL,
	`deny_skills` text DEFAULT '[]' NOT NULL,
	`deny_connectors` text DEFAULT '[]' NOT NULL,
	`browser_profile_id` text,
	`heartbeat_cron` text,
	`budget_usd` real,
	`autonomy_level` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`paused_reason` text,
	`max_steps` integer DEFAULT 60 NOT NULL,
	`max_wall_ms` integer DEFAULT 1800000 NOT NULL,
	`max_runs_per_hour` integer DEFAULT 12 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dept_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_org_slug_uq` ON `agents` (`org_id`,`slug`);--> statement-breakpoint
CREATE INDEX `agent_org_idx` ON `agents` (`org_id`);--> statement-breakpoint
CREATE INDEX `agent_dept_idx` ON `agents` (`dept_id`);--> statement-breakpoint
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`charter` text DEFAULT '' NOT NULL,
	`lead_agent_id` text,
	`budget_usd` real,
	`shared_skills` text DEFAULT '[]' NOT NULL,
	`shared_connectors` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dept_org_slug_uq` ON `departments` (`org_id`,`slug`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`mission` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT 'owner' NOT NULL,
	`budget_monthly_usd` real,
	`seat_seconds_monthly` integer,
	`default_provider` text,
	`utility_model` text,
	`policies` text DEFAULT '{}' NOT NULL,
	`default_skills` text DEFAULT '[]' NOT NULL,
	`default_connectors` text DEFAULT '[]' NOT NULL,
	`max_concurrent_runs` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`kill_switch` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_slug_uq` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `playbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`process` text DEFAULT 'sequential' NOT NULL,
	`manager_agent_id` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_org_name_uq` ON `playbooks` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`parent_comment_id` text,
	`author_kind` text NOT NULL,
	`author_id` text,
	`run_id` text,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comment_issue_idx` ON `comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comment_org_idx` ON `comments` (`org_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`parent_goal_id` text,
	`level` text DEFAULT 'org' NOT NULL,
	`dept_id` text,
	`owner_agent_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`success_metric` text DEFAULT '' NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`due` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goal_org_idx` ON `goals` (`org_id`);--> statement-breakpoint
CREATE INDEX `goal_parent_idx` ON `goals` (`parent_goal_id`);--> statement-breakpoint
CREATE TABLE `inbox_cursors` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`last_seen_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` integer NOT NULL,
	`goal_id` text,
	`project_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`expected_output` text DEFAULT '' NOT NULL,
	`task_type` text,
	`assignee_agent_id` text,
	`reviewer_agent_id` text,
	`creator_kind` text DEFAULT 'human' NOT NULL,
	`creator_id` text,
	`status` text DEFAULT 'backlog' NOT NULL,
	`blocked_reason` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`parent_issue_id` text,
	`blocked_by` text DEFAULT '[]' NOT NULL,
	`checkout_lock` text,
	`checkout_at` integer,
	`labels` text DEFAULT '[]' NOT NULL,
	`playbook_id` text,
	`review_outcome` text,
	`rework_count` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_org_status_idx` ON `issues` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `issue_assignee_idx` ON `issues` (`assignee_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `issue_parent_idx` ON `issues` (`parent_issue_id`);--> statement-breakpoint
CREATE INDEX `issue_goal_idx` ON `issues` (`goal_id`);--> statement-breakpoint
CREATE INDEX `issue_org_number_idx` ON `issues` (`org_id`,`number`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`goal_id` text,
	`name` text NOT NULL,
	`workspace_path` text,
	`budget_usd` real,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_org_idx` ON `projects` (`org_id`);--> statement-breakpoint
CREATE TABLE `cost_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`dept_id` text,
	`agent_id` text,
	`project_id` text,
	`run_id` text,
	`category` text DEFAULT 'run' NOT NULL,
	`provider` text,
	`model` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`subscription` integer DEFAULT false NOT NULL,
	`seat_seconds` integer DEFAULT 0 NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_org_ts_idx` ON `cost_ledger` (`org_id`,`ts`);--> statement-breakpoint
CREATE INDEX `ledger_agent_ts_idx` ON `cost_ledger` (`agent_id`,`ts`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`kind` text NOT NULL,
	`agent_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`run_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`locked_by` text,
	`locked_at` integer,
	`dedupe_key` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `job_due_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `job_dedupe_idx` ON `jobs` (`dedupe_key`,`status`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`org_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_event_seq_uq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`issue_id` text,
	`trigger` text NOT NULL,
	`provider` text,
	`model` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text,
	`started_at` integer,
	`ended_at` integer,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`subscription` integer DEFAULT false NOT NULL,
	`seat_seconds` integer DEFAULT 0 NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`error` text,
	`transcript_ref` text,
	`session_id` text,
	`capability_snapshot` text,
	`ingested_untrusted` integer DEFAULT false NOT NULL,
	`grade` text,
	`pid` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_org_idx` ON `runs` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_agent_idx` ON `runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_issue_idx` ON `runs` (`issue_id`);--> statement-breakpoint
CREATE INDEX `run_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `scorecards` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_type` text,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`issues_closed` integer DEFAULT 0 NOT NULL,
	`success_rate` real DEFAULT 0 NOT NULL,
	`rework_rate` real DEFAULT 0 NOT NULL,
	`cost_per_issue` real DEFAULT 0 NOT NULL,
	`avg_steps` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scorecard_agent_idx` ON `scorecards` (`agent_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `connector_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tool_allowlist` text,
	`tool_policies` text DEFAULT '{}' NOT NULL,
	`default_policy` text DEFAULT 'allowed' NOT NULL,
	`auth_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grant_uq` ON `connector_grants` (`connector_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `grant_agent_idx` ON `connector_grants` (`agent_id`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`scope` text DEFAULT 'org' NOT NULL,
	`scope_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`template_id` text,
	`config` text DEFAULT '{}' NOT NULL,
	`auth_ref` text,
	`tool_allowlist` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_scope_name_uq` ON `connectors` (`org_id`,`name`);--> statement-breakpoint
CREATE INDEX `connector_org_idx` ON `connectors` (`org_id`);--> statement-breakpoint
CREATE TABLE `eval_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`skill_id` text NOT NULL,
	`issue_id` text,
	`prompt` text NOT NULL,
	`success_criteria` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_usages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_id` text NOT NULL,
	`org_id` text,
	`version` integer NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`success` integer,
	`human_edited` integer DEFAULT false NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_usage_idx` ON `skill_usages` (`skill_id`,`ts`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`org_id` text,
	`version` integer NOT NULL,
	`commit_sha` text,
	`author` text NOT NULL,
	`run_id` text,
	`message` text DEFAULT '' NOT NULL,
	`content_hash` text NOT NULL,
	`eval` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_version_uq` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`scope` text NOT NULL,
	`scope_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`author` text DEFAULT 'human' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`eval_score` real,
	`path` text NOT NULL,
	`content_hash` text NOT NULL,
	`pinned_hash` text,
	`source` text,
	`has_scripts` integer DEFAULT false NOT NULL,
	`scan_findings` text DEFAULT '[]' NOT NULL,
	`created_run_id` text,
	`origin_issue_id` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_scope_name_uq` ON `skills` (`scope`,`scope_id`,`name`);--> statement-breakpoint
CREATE INDEX `skill_org_idx` ON `skills` (`org_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`run_id` text,
	`agent_id` text NOT NULL,
	`issue_id` text,
	`connector_id` text NOT NULL,
	`tool` text NOT NULL,
	`args_hash` text NOT NULL,
	`result_size` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`approval_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_call_run_idx` ON `tool_calls` (`run_id`);--> statement-breakpoint
CREATE INDEX `tool_call_org_idx` ON `tool_calls` (`org_id`,`ts`);--> statement-breakpoint
CREATE TABLE `tool_pins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text,
	`connector_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`schema_hash` text NOT NULL,
	`pending_hash` text,
	`status` text DEFAULT 'trusted' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_pin_uq` ON `tool_pins` (`connector_id`,`tool_name`);--> statement-breakpoint
CREATE TABLE `memories` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`entity` text,
	`task_type` text,
	`importance` real DEFAULT 0.5 NOT NULL,
	`confidence` real DEFAULT 0.7 NOT NULL,
	`source_run_id` text,
	`author` text DEFAULT 'agent' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`superseded_by` text,
	`pinned` integer DEFAULT false NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_unique` ON `memories` (`id`);--> statement-breakpoint
CREATE INDEX `memory_scope_idx` ON `memories` (`org_id`,`scope`,`scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `memory_kind_idx` ON `memories` (`org_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `memory_entity_idx` ON `memories` (`org_id`,`entity`);--> statement-breakpoint
CREATE TABLE `session_summaries` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`issue_id` text,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_summaries_run_id_unique` ON `session_summaries` (`run_id`);--> statement-breakpoint
CREATE INDEX `session_summary_agent_idx` ON `session_summaries` (`org_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_kind` text,
	`entity_id` text,
	`run_id` text,
	`issue_id` text,
	`data` text DEFAULT '{}' NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_org_ts_idx` ON `activity_log` (`org_id`,`ts`);--> statement-breakpoint
CREATE INDEX `activity_issue_idx` ON `activity_log` (`issue_id`,`ts`);--> statement-breakpoint
CREATE INDEX `activity_entity_idx` ON `activity_log` (`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`org_id` text,
	`agent_id` text,
	`run_id` text,
	`label` text,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `token_run_idx` ON `api_tokens` (`run_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`requester_agent_id` text,
	`run_id` text,
	`issue_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`decided_at` integer,
	`consumed_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approval_org_status_idx` ON `approvals` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `config_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot` text NOT NULL,
	`author` text NOT NULL,
	`note` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_uq` ON `config_revisions` (`entity_kind`,`entity_id`,`revision`);--> statement-breakpoint
CREATE TABLE `known_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`address` text NOT NULL,
	`first_approved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipient_uq` ON `known_recipients` (`org_id`,`address`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text,
	`dept_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`user_data_dir` text NOT NULL,
	`cookie_vault_ref` text,
	`domain_allowlist` text DEFAULT '[]' NOT NULL,
	`sensitive_domains` text DEFAULT '[]' NOT NULL,
	`leased_run_id` text,
	`leased_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_profile_slug_uq` ON `browser_profiles` (`org_id`,`slug`);--> statement-breakpoint
CREATE TABLE `browser_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`run_id` text,
	`issue_id` text,
	`agent_id` text,
	`reason` text DEFAULT '' NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`viewer_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`handed_back_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_session_run_idx` ON `browser_sessions` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_session_token_uq` ON `browser_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `gateway_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gateway_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`org_id` text,
	`agent_id` text,
	`issue_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_chat_uq` ON `gateway_chats` (`gateway_id`,`chat_id`);--> statement-breakpoint
CREATE TABLE `gateways` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`auth_ref` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`direction` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'generic' NOT NULL,
	`agent_id` text,
	`url` text,
	`events` text DEFAULT '[]' NOT NULL,
	`secret_ref` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_org_idx` ON `webhooks` (`org_id`,`direction`);