CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_agent_idx` ON `chat_messages` (`org_id`,`agent_id`,`created_at`);