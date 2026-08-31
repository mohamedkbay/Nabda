ALTER TABLE device_agent_credentials
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'simulation',
  ADD CONSTRAINT device_agent_credentials_mode_allowed CHECK (
    mode IN ('simulation', 'live')
  );

ALTER TABLE messages
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'simulation',
  ADD CONSTRAINT messages_execution_mode_allowed CHECK (
    execution_mode IN ('simulation', 'live')
  );

CREATE INDEX idx_messages_android_agent_mode_claim_ready
  ON messages (organization_id, device_id, execution_mode, scheduled_at, created_at)
  WHERE status = 'queued' AND dispatch_state IN ('pending', 'processing');

COMMENT ON COLUMN device_agent_credentials.mode IS
  'Server-authoritative operating mode. A credential cannot switch between simulation and live through request data.';

COMMENT ON COLUMN messages.execution_mode IS
  'Immutable execution boundary selected when the message is accepted; simulation work cannot later be dispatched live.';

CREATE FUNCTION nabda_prevent_device_credential_mode_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'device credential mode is immutable; rotate the credential instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_agent_credentials_mode_immutable
BEFORE UPDATE ON device_agent_credentials
FOR EACH ROW EXECUTE FUNCTION nabda_prevent_device_credential_mode_change();

CREATE FUNCTION nabda_prevent_message_execution_mode_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    RAISE EXCEPTION 'message execution mode is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_execution_mode_immutable
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION nabda_prevent_message_execution_mode_change();
