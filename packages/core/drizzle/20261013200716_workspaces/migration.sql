CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`root` text NOT NULL,
	`device_id` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	CONSTRAINT `fk_workspaces_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workspaces_user` ON `workspaces` (`user_id`);