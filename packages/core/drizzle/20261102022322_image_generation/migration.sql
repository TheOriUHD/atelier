CREATE TABLE `generated_images` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`session_id` text,
	`message_id` text,
	`call_id` text,
	`blob` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`prompt` text NOT NULL,
	`revised_prompt` text,
	`negative_prompt` text,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_name` text NOT NULL,
	`params` text NOT NULL,
	`seed` real,
	`cost_usd` real,
	`cost_estimated` integer DEFAULT false NOT NULL,
	`duration_ms` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_generated_images_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generated_images_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `image_model_cache` (
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`info` text NOT NULL,
	`discovered_at` integer NOT NULL,
	CONSTRAINT `image_model_cache_pk` PRIMARY KEY(`provider_id`, `model_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_image_providers` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`preset` text,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`options` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_personal_image_providers_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `images` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `generated_images_user` ON `generated_images` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `generated_images_session` ON `generated_images` (`session_id`);--> statement-breakpoint
CREATE INDEX `personal_image_providers_user` ON `personal_image_providers` (`user_id`);