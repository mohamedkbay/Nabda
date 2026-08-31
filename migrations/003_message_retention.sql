ALTER TABLE messages
  ADD COLUMN content_redacted_at TIMESTAMPTZ,
  ADD CONSTRAINT messages_content_redaction_time CHECK (
    content_redacted_at IS NULL OR content_redacted_at >= created_at
  );

CREATE INDEX idx_messages_retention_pending
  ON messages (organization_id, created_at, id)
  WHERE content_redacted_at IS NULL
    AND status IN ('delivered', 'failed', 'expired', 'cancelled');
