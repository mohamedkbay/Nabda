ALTER TABLE devices
  DROP CONSTRAINT devices_provider_allowed;

ALTER TABLE devices
  ADD CONSTRAINT devices_provider_allowed CHECK (
    provider IN ('mock', 'httpsms', 'android_agent')
  );

CREATE TABLE device_agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  hash_version SMALLINT NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_agent_credentials_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT device_agent_credentials_device_same_tenant
    FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id),
  CONSTRAINT device_agent_credentials_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT device_agent_credentials_hash_unique UNIQUE (token_hash),
  CONSTRAINT device_agent_credentials_prefix_format CHECK (
    token_prefix ~ '^nbda_device_[A-Za-z0-9_-]{12}$'
  ),
  CONSTRAINT device_agent_credentials_hash_format CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT device_agent_credentials_hash_version_positive CHECK (hash_version > 0),
  CONSTRAINT device_agent_credentials_revocation_time CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE UNIQUE INDEX ux_device_agent_credentials_one_active_per_device
  ON device_agent_credentials (organization_id, device_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_device_agent_credentials_device
  ON device_agent_credentials (organization_id, device_id, created_at DESC);

ALTER TABLE messages
  ADD COLUMN device_lease_token_hash CHAR(64),
  ADD COLUMN device_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN device_attempt_id TEXT,
  ADD CONSTRAINT messages_device_lease_pair CHECK (
    (device_lease_token_hash IS NULL AND device_lease_expires_at IS NULL)
    OR (device_lease_token_hash IS NOT NULL AND device_lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT messages_device_lease_hash_format CHECK (
    device_lease_token_hash IS NULL OR device_lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT messages_device_attempt_id_format CHECK (
    device_attempt_id IS NULL
    OR (
      char_length(device_attempt_id) BETWEEN 16 AND 128
      AND device_attempt_id ~ '^[A-Za-z0-9._:-]+$'
    )
  );

CREATE INDEX idx_messages_android_agent_claim_ready
  ON messages (organization_id, device_id, scheduled_at, created_at)
  WHERE status = 'queued' AND dispatch_state IN ('pending', 'processing');

CREATE TABLE device_agent_event_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL,
  message_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_token_hash CHAR(64) NOT NULL,
  requested_status message_status NOT NULL,
  resulting_status message_status NOT NULL,
  simulated BOOLEAN NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_agent_event_receipts_event_unique UNIQUE (organization_id, event_id),
  CONSTRAINT device_agent_event_receipts_device_same_tenant
    FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id),
  CONSTRAINT device_agent_event_receipts_message_same_tenant
    FOREIGN KEY (organization_id, message_id)
    REFERENCES messages (organization_id, id),
  CONSTRAINT device_agent_event_receipts_event_id_format CHECK (
    char_length(event_id) BETWEEN 16 AND 128
    AND event_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT device_agent_event_receipts_attempt_id_format CHECK (
    char_length(attempt_id) BETWEEN 16 AND 128
    AND attempt_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT device_agent_event_receipts_lease_hash_format CHECK (
    lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT device_agent_event_receipts_requested_status CHECK (
    requested_status IN ('sent', 'delivered', 'failed', 'cancelled')
  )
);

CREATE INDEX idx_device_agent_event_receipts_message
  ON device_agent_event_receipts (organization_id, message_id, created_at DESC);

CREATE TRIGGER device_agent_credentials_set_updated_at
BEFORE UPDATE ON device_agent_credentials
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();

COMMENT ON COLUMN device_agent_credentials.token_hash IS
  'Domain-separated HMAC-SHA-256 of the one-time device token; plaintext is never stored.';

COMMENT ON COLUMN messages.device_lease_token_hash IS
  'Domain-separated HMAC-SHA-256 of the current pull lease token; plaintext is never stored.';
