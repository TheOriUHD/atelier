ALTER TABLE `coop_memberships` ADD `local_title` text;--> statement-breakpoint
ALTER TABLE `coop_memberships` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `coop_memberships` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `coop_memberships` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `coop_memberships` ADD `finished_unseen_at` integer;--> statement-breakpoint
ALTER TABLE `session_participants` ADD `title` text;