CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_by_api_key_id UUID NOT NULL,
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  consent_reference TEXT,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contacts_tenant_identity UNIQUE (organization_id, id),
  CONSTRAINT contacts_creator_same_tenant
    FOREIGN KEY (organization_id, created_by_api_key_id)
    REFERENCES api_keys (organization_id, id),
  CONSTRAINT contacts_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 120
  ),
  CONSTRAINT contacts_phone_format CHECK (
    phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT contacts_consent_reference_valid CHECK (
    consent_reference IS NULL
    OR (consent_reference = btrim(consent_reference) AND char_length(consent_reference) BETWEEN 1 AND 255)
  ),
  CONSTRAINT contacts_tags_valid CHECK (
    cardinality(tags) <= 50 AND array_position(tags, NULL) IS NULL
  ),
  CONSTRAINT contacts_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT contacts_metadata_size CHECK (octet_length(metadata::text) <= 4096),
  CONSTRAINT contacts_deletion_time CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE UNIQUE INDEX ux_contacts_active_phone
  ON contacts (organization_id, phone_e164)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_contacts_org_page
  ON contacts (organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_contacts_creator
  ON contacts (organization_id, created_by_api_key_id, created_at DESC);

CREATE INDEX idx_contacts_active_tags
  ON contacts USING GIN (tags)
  WHERE deleted_at IS NULL;

CREATE TRIGGER contacts_set_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION nabda_set_updated_at();
