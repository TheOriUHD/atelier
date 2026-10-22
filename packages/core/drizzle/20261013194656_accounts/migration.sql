CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_kind` text NOT NULL,
	`device_id` text,
	`user_agent` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	CONSTRAINT `fk_devices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	CONSTRAINT `fk_invites_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_invites_used_by_users_id_fk` FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `user_prefs` (
	`user_id` text PRIMARY KEY,
	`prefs` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_user_prefs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`avatar_blob` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_active_at` integer,
	`disabled_at` integer
);
--> statement-breakpoint
ALTER TABLE `files` ADD `user_id` text REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `projects` ADD `user_id` text REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` text REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `user_id` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `devices_user` ON `devices` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username` ON `users` (`username`);