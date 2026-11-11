DROP INDEX `issue_org_number_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_org_number_uq` ON `issues` (`org_id`,`number`);--> statement-breakpoint
ALTER TABLE `memories` ADD `external_ref` text;--> statement-breakpoint
ALTER TABLE `browser_profiles` ADD `engine` text DEFAULT 'bundled' NOT NULL;--> statement-breakpoint
ALTER TABLE `browser_profiles` ADD `headed` integer;