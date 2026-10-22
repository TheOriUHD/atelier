ALTER TABLE `workspaces` ADD `trusted` integer DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE `workspaces` SET `trusted` = false WHERE `kind` = 'codespace';
