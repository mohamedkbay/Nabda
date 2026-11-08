CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_organization` ON `api_keys` (`organization_id`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`message_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`acknowledged_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commands_device_pending` ON `commands` (`device_id`,`acknowledged_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`permission_granted` integer DEFAULT 0 NOT NULL,
	`sim_selected` integer DEFAULT 0 NOT NULL,
	`app_version` text,
	`android_version` text,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_organization` ON `devices` (`organization_id`);--> statement-breakpoint
CREATE TABLE `message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_device_event` ON `message_events` (`device_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`idempotency_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`sandbox` integer DEFAULT 0 NOT NULL,
	`cancellation_requested` integer DEFAULT 0 NOT NULL,
	`send_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`handed_off_at` text,
	`parts_total` integer,
	`parts_sent` integer,
	`parts_delivered` integer,
	`failure_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_org_idempotency` ON `messages` (`organization_id`,`idempotency_hash`);--> statement-breakpoint
CREATE INDEX `messages_org_created` ON `messages` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_device` ON `messages` (`device_id`,`status`);--> statement-breakpoint
CREATE TABLE `opt_outs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`phone_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opt_outs_org_phone` ON `opt_outs` (`organization_id`,`phone_hash`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_owner_id_unique` ON `organizations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_device_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairings_token_hash_unique` ON `pairings` (`token_hash`);--> statement-breakpoint
CREATE INDEX `pairings_organization` ON `pairings` (`organization_id`);