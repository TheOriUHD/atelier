CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`section` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`parent_id` text,
	`sensitive` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'chat' NOT NULL,
	`source_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_memory_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `memory_entries_user` ON `memory_entries` (`user_id`,`section`);
--> statement-breakpoint
CREATE TABLE `memory_progress` (
	`session_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`through_message_id` text,
	`processed_at` integer NOT NULL,
	CONSTRAINT `fk_memory_progress_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
