CREATE TABLE organization_dispatch_fences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  last_message_id UUID NOT NULL,
  last_dispatch_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_dispatch_fences_message_same_tenant
    FOREIGN KEY (organization_id, last_message_id)
    REFERENCES messages (organization_id, id)
);

CREATE TABLE device_dispatch_fences (
  organization_id UUID NOT NULL,
  device_id UUID NOT NULL,
  last_message_id UUID NOT NULL,
  last_dispatch_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, device_id),
  CONSTRAINT device_dispatch_fences_device_same_tenant
    FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id),
  CONSTRAINT device_dispatch_fences_message_same_tenant
    FOREIGN KEY (organization_id, last_message_id)
    REFERENCES messages (organization_id, id)
);

ALTER TABLE device_agent_event_receipts
  ADD COLUMN request_hash CHAR(64);

-- Migration 005 was local-only, but generate a deliberately non-replayable
-- marker if a developer database already contains receipts. A legacy replay
-- will safely conflict instead of accepting a request whose full semantics
-- were not retained.
UPDATE device_agent_event_receipts
SET request_hash = encode(
  digest('legacy-device-event:' || organization_id::text || ':' || event_id || ':' || id::text, 'sha256'),
  'hex'
)
WHERE request_hash IS NULL;

ALTER TABLE device_agent_event_receipts
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT device_agent_event_receipts_request_hash_format CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  );

COMMENT ON COLUMN device_agent_event_receipts.request_hash IS
  'SHA-256 of the canonical non-secret event request semantics; used to reject mutated idempotency replays.';
