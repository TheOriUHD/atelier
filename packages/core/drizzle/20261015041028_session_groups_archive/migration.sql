CREATE TABLE `session_groups` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_session_groups_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `group_id` text REFERENCES session_groups(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_at` integer;