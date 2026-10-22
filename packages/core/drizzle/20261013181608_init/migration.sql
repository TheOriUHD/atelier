CREATE TABLE `artifact_versions` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `artifact_versions_pk` PRIMARY KEY(`artifact_id`, `version`),
	CONSTRAINT `fk_artifact_versions_artifact_id_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`identifier` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`language` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_artifacts_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY,
	`session_id` text,
	`message_id` text,
	`project_id` text,
	`blob` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`tokens` integer,
	`kind` text NOT NULL,
	`workspace_path` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_files_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_files_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`parent_id` text,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`model` text,
	`usage` text,
	`stop_reason` text,
	`error` text,
	`kind` text DEFAULT 'normal' NOT NULL,
	`summarizes_through_id` text,
	`search_text` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_messages_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `model_cache` (
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`info` text NOT NULL,
	`discovered_at` integer NOT NULL,
	CONSTRAINT `model_cache_pk` PRIMARY KEY(`provider_id`, `model_id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tail` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`rotated_at` integer,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`mode` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`project_id` text,
	`workspace_id` text,
	`parent_session_id` text,
	`model` text,
	`effort` text,
	`permission_mode` text,
	`overrides` text DEFAULT '{}' NOT NULL,
	`head_message_id` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`pending` text,
	`todos` text DEFAULT '[]' NOT NULL,
	`system_snapshot` text,
	`tools_snapshot` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`pinned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sessions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY,
	`ts` integer NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`session_id` text,
	`mode` text,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`tokens_per_second` real,
	`cost_usd` real
);
--> statement-breakpoint
CREATE INDEX `artifacts_session` ON `artifacts` (`session_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `files_project` ON `files` (`project_id`);--> statement-breakpoint
CREATE INDEX `files_session` ON `files` (`session_id`);--> statement-breakpoint
CREATE INDEX `messages_session` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_parent` ON `messages` (`parent_id`);--> statement-breakpoint
CREATE INDEX `sessions_updated` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_project` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `usage_ts` ON `usage_events` (`ts`);