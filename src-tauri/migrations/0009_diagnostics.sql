CREATE TABLE `diagnostics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`details` text,
	`screen` text
);
--> statement-breakpoint
CREATE INDEX `diagnostics_at` ON `diagnostics` (`at`);