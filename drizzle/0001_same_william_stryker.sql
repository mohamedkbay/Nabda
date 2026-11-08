CREATE TABLE `browser_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `independent_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `browser_sessions_user` ON `browser_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `browser_sessions_expiry` ON `browser_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `independent_users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `independent_users_github_id_unique` ON `independent_users` (`github_id`);--> statement-breakpoint
CREATE TABLE `oauth_attempts` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`verifier` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_attempts_browser_hash_unique` ON `oauth_attempts` (`browser_hash`);--> statement-breakpoint
CREATE INDEX `oauth_attempts_expiry` ON `oauth_attempts` (`expires_at`);