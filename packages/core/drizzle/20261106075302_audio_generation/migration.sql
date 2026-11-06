ALTER TABLE `usage_events` ADD `audios` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `audio_seconds` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `audio_chars` integer DEFAULT 0 NOT NULL;