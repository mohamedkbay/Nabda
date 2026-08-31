CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE organization_status AS ENUM (
  'active',
  'suspended',
  'closed'
);

CREATE TYPE user_role AS ENUM (
  'owner',
  'admin',
  'developer',
  'billing',
  'viewer'
);

CREATE TYPE user_status AS ENUM (
  'invited',
  'active',
  'disabled'
);

CREATE TYPE subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'expired'
);

CREATE TYPE device_status AS ENUM (
  'pending',
  'active',
  'offline',
  'disabled'
);

CREATE TYPE message_status AS ENUM (
  'queued',
  'sent',
  'delivered',
  'failed',
  'expired',
  'cancelled'
);

CREATE TYPE webhook_status AS ENUM (
  'active',
  'disabled'
);

CREATE TYPE webhook_delivery_status AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'dead'
);

CREATE TYPE audit_actor_type AS ENUM (
  'user',
  'api_key',
  'system'
);

CREATE TYPE outbox_job_type AS ENUM (
  'message.dispatch',
  'webhook.deliver'
);

CREATE TYPE outbox_job_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'dead'
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status organization_status NOT NULL DEFAULT 'active',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspended_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT organizations_slug_format CHECK (
    char_length(slug) BETWEEN 1 AND 63
    AND slug = lower(slug)
    AND slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'
    AND slug !~ '-$'
  ),
  CONSTRAINT organizations_slug_unique UNIQUE (slug),
  CONSTRAINT organizations_settings_object CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT organizations_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT organizations_suspended_time CHECK (suspended_at IS NULL OR suspended_at >= created_at),
  CONSTRAINT organizations_closed_time CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role user_role NOT NULL,
  status user_status NOT NULL DEFAULT 'invited',
  last_login_at TIMESTAMPTZ,
  invited_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT users_tenant_email_unique UNIQUE (organization_id, email),
  CONSTRAINT users_email_format CHECK (
    char_length(email) BETWEEN 3 AND 320
    AND email = lower(email)
    AND position('@' IN email) > 1
  ),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT users_password_hash_length CHECK (
    password_hash IS NULL OR char_length(password_hash) BETWEEN 32 AND 512
  )
);

CREATE INDEX idx_users_org_status ON users (organization_id, status);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_by_user_id UUID,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL,
  hash_version SMALLINT NOT NULL DEFAULT 1,
  scopes TEXT[] NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT api_keys_prefix_unique UNIQUE (key_prefix),
  CONSTRAINT api_keys_hash_unique UNIQUE (key_hash),
  CONSTRAINT api_keys_creator_same_tenant
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT api_keys_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT api_keys_prefix_format CHECK (
    char_length(key_prefix) BETWEEN 8 AND 32
    AND key_prefix ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT api_keys_hash_format CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_keys_hash_version_positive CHECK (hash_version > 0),
  CONSTRAINT api_keys_scopes_not_empty CHECK (
    cardinality(scopes) > 0 AND array_position(scopes, NULL) IS NULL
  ),
  CONSTRAINT api_keys_expiry_time CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT api_keys_revocation_time CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_api_keys_org_active
  ON api_keys (organization_id, key_prefix)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX ux_api_keys_org_active_name
  ON api_keys (organization_id, name)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_api_keys_creator
  ON api_keys (organization_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  monthly_message_limit BIGINT NOT NULL,
  per_minute_message_limit INTEGER NOT NULL,
  max_devices INTEGER NOT NULL,
  max_api_keys INTEGER NOT NULL,
  max_webhooks INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  monthly_price_minor BIGINT NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_unique UNIQUE (code),
  CONSTRAINT plans_code_format CHECK (
    char_length(code) BETWEEN 1 AND 64
    AND code = lower(code)
    AND code ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  CONSTRAINT plans_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT plans_monthly_message_limit_positive CHECK (monthly_message_limit > 0),
  CONSTRAINT plans_per_minute_limit_positive CHECK (per_minute_message_limit > 0),
  CONSTRAINT plans_max_devices_positive CHECK (max_devices > 0),
  CONSTRAINT plans_max_api_keys_positive CHECK (max_api_keys > 0),
  CONSTRAINT plans_max_webhooks_nonnegative CHECK (max_webhooks >= 0),
  CONSTRAINT plans_retention_days_positive CHECK (retention_days > 0),
  CONSTRAINT plans_monthly_price_nonnegative CHECK (monthly_price_minor >= 0),
  CONSTRAINT plans_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT plans_features_object CHECK (jsonb_typeof(features) = 'object')
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  plan_id UUID NOT NULL REFERENCES plans(id),
  status subscription_status NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  messages_used BIGINT NOT NULL DEFAULT 0,
  message_limit_override BIGINT,
  per_minute_limit_override INTEGER,
  trial_ends_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  billing_provider TEXT,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT subscriptions_period_order CHECK (current_period_end > current_period_start),
  CONSTRAINT subscriptions_messages_used_nonnegative CHECK (messages_used >= 0),
  CONSTRAINT subscriptions_message_override_positive CHECK (
    message_limit_override IS NULL OR message_limit_override > 0
  ),
  CONSTRAINT subscriptions_rate_override_positive CHECK (
    per_minute_limit_override IS NULL OR per_minute_limit_override > 0
  ),
  CONSTRAINT subscriptions_trial_time CHECK (
    trial_ends_at IS NULL OR trial_ends_at >= current_period_start
  ),
  CONSTRAINT subscriptions_cancel_time CHECK (
    cancelled_at IS NULL OR cancelled_at >= created_at
  ),
  CONSTRAINT subscriptions_billing_reference_pair CHECK (
    (external_subscription_id IS NULL)
    OR (billing_provider IS NOT NULL AND char_length(billing_provider) > 0)
  )
);

CREATE UNIQUE INDEX ux_subscriptions_one_current
  ON subscriptions (organization_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'paused');

CREATE UNIQUE INDEX ux_subscriptions_external
  ON subscriptions (billing_provider, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;

CREATE INDEX idx_subscriptions_org_period
  ON subscriptions (organization_id, current_period_start DESC, current_period_end DESC);

CREATE INDEX idx_subscriptions_plan
  ON subscriptions (plan_id);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_by_user_id UUID,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_external_id TEXT,
  sender_number TEXT,
  status device_status NOT NULL DEFAULT 'pending',
  encrypted_config TEXT,
  provider_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT devices_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT devices_creator_same_tenant
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT devices_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT devices_provider_allowed CHECK (
    provider IN ('mock', 'httpsms')
  ),
  CONSTRAINT devices_sender_phone_format CHECK (
    sender_number IS NULL OR sender_number ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT devices_encrypted_config_length CHECK (
    encrypted_config IS NULL OR char_length(encrypted_config) BETWEEN 20 AND 8192
  ),
  CONSTRAINT devices_provider_config_object CHECK (jsonb_typeof(provider_config) = 'object'),
  CONSTRAINT devices_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT devices_disabled_time CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);

CREATE UNIQUE INDEX ux_devices_provider_external
  ON devices (organization_id, provider, provider_external_id)
  WHERE provider_external_id IS NOT NULL;

CREATE UNIQUE INDEX ux_devices_active_sender
  ON devices (organization_id, provider, sender_number)
  WHERE sender_number IS NOT NULL AND status <> 'disabled';

CREATE INDEX idx_devices_org_status ON devices (organization_id, status);

CREATE INDEX idx_devices_creator
  ON devices (organization_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  api_key_id UUID NOT NULL,
  device_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'transactional',
  to_number TEXT NOT NULL,
  from_number TEXT,
  content TEXT NOT NULL,
  client_reference TEXT,
  consent_reference TEXT,
  consent_captured_at TIMESTAMPTZ NOT NULL,
  status message_status NOT NULL DEFAULT 'queued',
  dispatch_state TEXT NOT NULL DEFAULT 'pending',
  dispatch_started_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status_check_count INTEGER NOT NULL DEFAULT 0,
  last_status_checked_at TIMESTAMPTZ,
  provider_message_id TEXT,
  provider_status TEXT,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  failure_reason TEXT,
  segments SMALLINT NOT NULL DEFAULT 1,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT messages_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT messages_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT messages_api_key_same_tenant
    FOREIGN KEY (organization_id, api_key_id)
    REFERENCES api_keys (organization_id, id),
  CONSTRAINT messages_device_same_tenant
    FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id),
  CONSTRAINT messages_idempotency_key_length CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 255
  ),
  CONSTRAINT messages_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT messages_purpose_allowed CHECK (
    purpose IN ('transactional', 'authentication', 'service')
  ),
  CONSTRAINT messages_to_phone_format CHECK (to_number ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT messages_from_phone_format CHECK (
    from_number IS NULL OR from_number ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT messages_content_length CHECK (char_length(content) BETWEEN 1 AND 1000),
  CONSTRAINT messages_dispatch_state_allowed CHECK (
    dispatch_state IN ('pending', 'processing', 'completed', 'manual_review')
  ),
  CONSTRAINT messages_attempt_count_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT messages_status_check_count_nonnegative CHECK (status_check_count >= 0),
  CONSTRAINT messages_client_reference_length CHECK (
    client_reference IS NULL OR char_length(client_reference) BETWEEN 1 AND 255
  ),
  CONSTRAINT messages_consent_reference_length CHECK (
    consent_reference IS NULL OR char_length(consent_reference) BETWEEN 1 AND 255
  ),
  CONSTRAINT messages_segments_positive CHECK (segments > 0),
  CONSTRAINT messages_expiry_after_schedule CHECK (
    expires_at > scheduled_at
  ),
  CONSTRAINT messages_provider_metadata_object CHECK (jsonb_typeof(provider_metadata) = 'object'),
  CONSTRAINT messages_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_messages_org_created
  ON messages (organization_id, created_at DESC);

CREATE INDEX idx_messages_org_status_created
  ON messages (organization_id, status, created_at DESC);

CREATE INDEX idx_messages_dispatch_ready
  ON messages (scheduled_at, created_at)
  WHERE status = 'queued' AND dispatch_state = 'pending';

CREATE INDEX idx_messages_stalled_dispatch
  ON messages (dispatch_started_at)
  WHERE status = 'queued' AND dispatch_state = 'processing';

CREATE INDEX idx_messages_status_check_ready
  ON messages ((COALESCE(last_status_checked_at, sent_at)), sent_at)
  WHERE status = 'sent' AND provider_message_id IS NOT NULL;

CREATE INDEX idx_messages_api_key
  ON messages (organization_id, api_key_id, created_at DESC);

CREATE INDEX idx_messages_device
  ON messages (organization_id, device_id, created_at DESC);

CREATE UNIQUE INDEX ux_messages_provider_id
  ON messages (organization_id, device_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE message_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  message_id UUID NOT NULL,
  type TEXT NOT NULL,
  status message_status,
  provider_status TEXT,
  provider_event_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_events_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT message_events_message_same_tenant
    FOREIGN KEY (organization_id, message_id)
    REFERENCES messages (organization_id, id),
  CONSTRAINT message_events_type_length CHECK (char_length(type) BETWEEN 1 AND 100),
  CONSTRAINT message_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX idx_message_events_message_time
  ON message_events (organization_id, message_id, occurred_at, id);

CREATE UNIQUE INDEX ux_message_events_provider_event
  ON message_events (organization_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_by_user_id UUID,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  subscribed_events TEXT[] NOT NULL,
  encrypted_secret TEXT NOT NULL,
  signing_version TEXT NOT NULL DEFAULT 'v1',
  status webhook_status NOT NULL DEFAULT 'active',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhooks_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT webhooks_creator_same_tenant
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT webhooks_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT webhooks_endpoint_length CHECK (char_length(url) BETWEEN 8 AND 2048),
  CONSTRAINT webhooks_endpoint_scheme CHECK (url ~ '^https://[^[:space:]]+$'),
  CONSTRAINT webhooks_events_not_empty CHECK (
    cardinality(subscribed_events) > 0
    AND array_position(subscribed_events, NULL) IS NULL
  ),
  CONSTRAINT webhooks_encrypted_secret_length CHECK (
    char_length(encrypted_secret) BETWEEN 20 AND 8192
  ),
  CONSTRAINT webhooks_signing_version_not_empty CHECK (char_length(signing_version) > 0),
  CONSTRAINT webhooks_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT webhooks_disabled_time CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);

CREATE INDEX idx_webhooks_org_status ON webhooks (organization_id, status);

CREATE INDEX idx_webhooks_creator
  ON webhooks (organization_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  webhook_id UUID NOT NULL,
  message_event_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_attempt_at TIMESTAMPTZ,
  response_status INTEGER,
  response_body TEXT,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT webhook_deliveries_event_unique UNIQUE (
    organization_id,
    webhook_id,
    message_event_id
  ),
  CONSTRAINT webhook_deliveries_webhook_same_tenant
    FOREIGN KEY (organization_id, webhook_id)
    REFERENCES webhooks (organization_id, id),
  CONSTRAINT webhook_deliveries_event_same_tenant
    FOREIGN KEY (organization_id, message_event_id)
    REFERENCES message_events (organization_id, id),
  CONSTRAINT webhook_deliveries_event_type_length CHECK (
    char_length(event_type) BETWEEN 1 AND 100
  ),
  CONSTRAINT webhook_deliveries_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT webhook_deliveries_attempts_valid CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 50
  ),
  CONSTRAINT webhook_deliveries_lock_pair CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  ),
  CONSTRAINT webhook_deliveries_response_status_valid CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  )
);

CREATE INDEX idx_webhook_deliveries_ready
  ON webhook_deliveries (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_webhook_deliveries_webhook_time
  ON webhook_deliveries (organization_id, webhook_id, created_at DESC);

CREATE INDEX idx_webhook_deliveries_event
  ON webhook_deliveries (organization_id, message_event_id);

CREATE TABLE opt_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  phone_e164 TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  source TEXT NOT NULL,
  reason TEXT,
  created_by_user_id UUID,
  revoked_by_user_id UUID,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT opt_outs_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT opt_outs_creator_same_tenant
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT opt_outs_revoker_same_tenant
    FOREIGN KEY (organization_id, revoked_by_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT opt_outs_phone_format CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT opt_outs_channel_allowed CHECK (channel = 'sms'),
  CONSTRAINT opt_outs_source_length CHECK (char_length(source) BETWEEN 1 AND 100),
  CONSTRAINT opt_outs_revoke_time CHECK (revoked_at IS NULL OR revoked_at >= opted_out_at),
  CONSTRAINT opt_outs_revoker_requires_revocation CHECK (
    revoked_by_user_id IS NULL OR revoked_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX ux_opt_outs_active_phone
  ON opt_outs (organization_id, channel, phone_e164)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_opt_outs_org_time
  ON opt_outs (organization_id, opted_out_at DESC);

CREATE INDEX idx_opt_outs_creator
  ON opt_outs (organization_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX idx_opt_outs_revoker
  ON opt_outs (organization_id, revoked_by_user_id)
  WHERE revoked_by_user_id IS NOT NULL;

CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_type audit_actor_type NOT NULL,
  actor_user_id UUID,
  actor_api_key_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  request_id TEXT,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_user_same_tenant
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  CONSTRAINT audit_logs_api_key_same_tenant
    FOREIGN KEY (organization_id, actor_api_key_id)
    REFERENCES api_keys (organization_id, id),
  CONSTRAINT audit_logs_actor_consistency CHECK (
    (actor_type = 'system' AND actor_user_id IS NULL AND actor_api_key_id IS NULL)
    OR (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_api_key_id IS NULL)
    OR (actor_type = 'api_key' AND actor_user_id IS NULL AND actor_api_key_id IS NOT NULL)
  ),
  CONSTRAINT audit_logs_action_length CHECK (char_length(action) BETWEEN 1 AND 120),
  CONSTRAINT audit_logs_resource_type_length CHECK (
    char_length(resource_type) BETWEEN 1 AND 100
  ),
  CONSTRAINT audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_audit_logs_org_created
  ON audit_logs (organization_id, created_at DESC, id DESC);

CREATE INDEX idx_audit_logs_resource
  ON audit_logs (organization_id, resource_type, resource_id, created_at DESC);

CREATE INDEX idx_audit_logs_actor_user
  ON audit_logs (organization_id, actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX idx_audit_logs_actor_api_key
  ON audit_logs (organization_id, actor_api_key_id, created_at DESC)
  WHERE actor_api_key_id IS NOT NULL;

CREATE TABLE outbox_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  kind outbox_job_type NOT NULL,
  status outbox_job_status NOT NULL DEFAULT 'pending',
  message_id UUID,
  webhook_delivery_id UUID,
  aggregate_id UUID GENERATED ALWAYS AS (COALESCE(message_id, webhook_delivery_id)) STORED,
  deduplication_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_jobs_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT outbox_jobs_deduplication_unique UNIQUE (
    organization_id,
    kind,
    deduplication_key
  ),
  CONSTRAINT outbox_jobs_message_same_tenant
    FOREIGN KEY (organization_id, message_id)
    REFERENCES messages (organization_id, id),
  CONSTRAINT outbox_jobs_webhook_delivery_same_tenant
    FOREIGN KEY (organization_id, webhook_delivery_id)
    REFERENCES webhook_deliveries (organization_id, id),
  CONSTRAINT outbox_jobs_target_matches_type CHECK (
    (
      kind = 'message.dispatch'
      AND message_id IS NOT NULL
      AND webhook_delivery_id IS NULL
    )
    OR (
      kind = 'webhook.deliver'
      AND message_id IS NULL
      AND webhook_delivery_id IS NOT NULL
    )
  ),
  CONSTRAINT outbox_jobs_deduplication_key_length CHECK (
    char_length(deduplication_key) BETWEEN 1 AND 255
  ),
  CONSTRAINT outbox_jobs_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_jobs_attempts_valid CHECK (
    attempts >= 0 AND max_attempts BETWEEN 1 AND 50
  ),
  CONSTRAINT outbox_jobs_lock_pair CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  ),
  CONSTRAINT outbox_jobs_completion_time CHECK (
    completed_at IS NULL OR completed_at >= created_at
  )
);

CREATE UNIQUE INDEX ux_outbox_message_dispatch
  ON outbox_jobs (organization_id, message_id)
  WHERE kind = 'message.dispatch';

CREATE UNIQUE INDEX ux_outbox_webhook_delivery
  ON outbox_jobs (organization_id, webhook_delivery_id)
  WHERE kind = 'webhook.deliver';

CREATE INDEX idx_outbox_jobs_ready
  ON outbox_jobs (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_outbox_jobs_stale_processing
  ON outbox_jobs (locked_at)
  WHERE status = 'processing';

CREATE INDEX idx_outbox_jobs_completed
  ON outbox_jobs (completed_at)
  WHERE status = 'completed';

CREATE FUNCTION nabda_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER api_keys_set_updated_at
BEFORE UPDATE ON api_keys
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER plans_set_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER devices_set_updated_at
BEFORE UPDATE ON devices
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER messages_set_updated_at
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER webhooks_set_updated_at
BEFORE UPDATE ON webhooks
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER webhook_deliveries_set_updated_at
BEFORE UPDATE ON webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER opt_outs_set_updated_at
BEFORE UPDATE ON opt_outs
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

CREATE TRIGGER outbox_jobs_set_updated_at
BEFORE UPDATE ON outbox_jobs
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();
