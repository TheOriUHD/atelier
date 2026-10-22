CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`path` text NOT NULL,
	`before_blob` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_checkpoints_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoints_turn_path` ON `checkpoints` (`session_id`,`message_id`,`path`);--> statement-breakpoint
CREATE INDEX `checkpoints_created` ON `checkpoints` (`created_at`);