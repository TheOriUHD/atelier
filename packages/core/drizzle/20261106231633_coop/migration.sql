CREATE TABLE `coop_memberships` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`relay_url` text NOT NULL,
	`room_id` text NOT NULL,
	`psk_secret` text NOT NULL,
	`host_key` text,
	`host_name` text NOT NULL,
	`host_session_id` text,
	`title` text NOT NULL,
	`mode` text NOT NULL,
	`copy_session_id` text,
	`joined_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `fk_coop_memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `coop_rooms` (
	`session_id` text PRIMARY KEY,
	`relay_url` text,
	`room_id` text,
	`host_token_secret` text,
	`invite_secret` text,
	`invite_expires_at` integer,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `fk_coop_rooms_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_lanes` (
	`session_id` text NOT NULL,
	`lane` text NOT NULL,
	`system_snapshot` text,
	`tools_snapshot` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `session_lanes_pk` PRIMARY KEY(`session_id`, `lane`),
	CONSTRAINT `fk_session_lanes_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_participants` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`peer_key` text,
	`name` text NOT NULL,
	`avatar` text,
	`role` text NOT NULL,
	`models` text DEFAULT 'host' NOT NULL,
	`model` text,
	`trusted` integer DEFAULT false NOT NULL,
	`pinned_at` integer,
	`group_id` text,
	`archived_at` integer,
	`finished_unseen_at` integer,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	CONSTRAINT `session_participants_pk` PRIMARY KEY(`session_id`, `id`),
	CONSTRAINT `fk_session_participants_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_participants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `author` text;--> statement-breakpoint
CREATE INDEX `session_participants_user` ON `session_participants` (`user_id`);