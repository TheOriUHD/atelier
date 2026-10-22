ALTER TABLE `sessions` ADD `temporary` text;--> statement-breakpoint
CREATE INDEX `sessions_temporary` ON `sessions` (`temporary`);
