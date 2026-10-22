ALTER TABLE `memory_entries` ADD `project_id` text REFERENCES `projects`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE `memory_entries` SET `section` = 'area' WHERE `section` = 'project';
--> statement-breakpoint
ALTER TABLE `memory_entries` DROP COLUMN `parent_id`;
