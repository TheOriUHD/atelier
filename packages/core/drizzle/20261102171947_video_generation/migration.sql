ALTER TABLE `generated_images` ADD `kind` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `media_seconds` real;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `fps` real;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `audio` integer;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `videos` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `video_seconds` real DEFAULT 0 NOT NULL;