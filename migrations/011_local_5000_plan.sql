-- A self-hosted operator plan sized for one approved 5,000-recipient campaign.
-- The per-minute limit remains explicit to protect the handset and SIM.
UPDATE plans
SET
  name = 'Local 5000',
  description = 'Free self-hosted plan for a customer-owned phone and SIM.',
  monthly_message_limit = 5000,
  per_minute_message_limit = 10,
  max_contacts = 10000,
  features = '{"free_forever": true, "customer_owned_sim": true, "monthly_messages": 5000}'::jsonb,
  updated_at = now()
WHERE code = 'free';
