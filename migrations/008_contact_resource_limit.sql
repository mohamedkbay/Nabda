ALTER TABLE plans
  ADD COLUMN max_contacts INTEGER NOT NULL DEFAULT 10000,
  ADD CONSTRAINT plans_max_contacts_positive CHECK (max_contacts > 0);

UPDATE plans
SET max_contacts = 100
WHERE code = 'trial';

-- Deleted contacts carry no blocklist semantics; audit_logs preserve the deletion fact.
-- Remove legacy tombstones so repeated create/delete cycles cannot accumulate recipient PII.
DELETE FROM contacts
WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN plans.max_contacts IS
  'Maximum number of non-deleted recipient contacts an organization may retain under this plan.';
