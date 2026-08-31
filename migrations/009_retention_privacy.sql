ALTER TABLE messages
  ALTER COLUMN to_number DROP NOT NULL,
  ADD CONSTRAINT messages_recipient_retained_while_operational CHECK (
    to_number IS NOT NULL OR content_redacted_at IS NOT NULL
  );

CREATE INDEX idx_messages_expiry_sweep
  ON messages (expires_at, id)
  WHERE status = 'queued' AND dispatch_state = 'pending';

CREATE INDEX idx_messages_android_sent_expiry
  ON messages (expires_at, id)
  WHERE status = 'sent' AND provider_message_id IS NULL;

UPDATE audit_logs
SET metadata = metadata - 'phone'
WHERE resource_type = 'opt_out' AND metadata ? 'phone';

COMMENT ON COLUMN messages.to_number IS
  'Recipient E.164 while operationally required; set to NULL by terminal-message retention cleanup.';
