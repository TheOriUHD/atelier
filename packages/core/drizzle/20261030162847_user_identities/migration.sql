CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`new_accounts` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_user_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_identities_provider_id_oidc_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_subject` ON `user_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `user_identities_user` ON `user_identities` (`user_id`);
