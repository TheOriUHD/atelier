CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`actor` text,
	`target` text,
	`summary` text NOT NULL,
	`detail` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_kind` ON `audit_events` (`kind`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor` ON `audit_events` (`actor`,`at`);