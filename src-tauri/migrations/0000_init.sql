CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`position` text NOT NULL,
	`props` text DEFAULT '{}' NOT NULL,
	`content` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `blocks_parent` ON `blocks` (`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `device_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text NOT NULL,
	`page_id` text,
	`type` text NOT NULL,
	`parent_id` text,
	`position` text NOT NULL,
	`props` text NOT NULL,
	`content` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revisions_block` ON `revisions` (`block_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `revisions_page` ON `revisions` (`page_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
