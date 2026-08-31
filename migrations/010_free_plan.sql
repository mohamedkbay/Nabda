-- Replace the time-limited evaluation with a permanent, zero-price plan.
-- Limits remain explicit so "free" never means unlimited or abuse-tolerant.
INSERT INTO plans (
  code,
  name,
  description,
  monthly_message_limit,
  per_minute_message_limit,
  max_devices,
  max_api_keys,
  max_webhooks,
  max_contacts,
  retention_days,
  monthly_price_minor,
  currency,
  features,
  is_active
)
VALUES (
  'free',
  'Free',
  'A permanent free platform plan with explicit fair-use and safety limits.',
  1000,
  10,
  1,
  3,
  2,
  500,
  30,
  0,
  'LYD',
  '{"free_forever": true, "customer_owned_sim": true, "unlimited_messages": false}'::jsonb,
  true
)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  monthly_message_limit = EXCLUDED.monthly_message_limit,
  per_minute_message_limit = EXCLUDED.per_minute_message_limit,
  max_devices = EXCLUDED.max_devices,
  max_api_keys = EXCLUDED.max_api_keys,
  max_webhooks = EXCLUDED.max_webhooks,
  max_contacts = EXCLUDED.max_contacts,
  retention_days = EXCLUDED.retention_days,
  monthly_price_minor = EXCLUDED.monthly_price_minor,
  currency = EXCLUDED.currency,
  features = EXCLUDED.features,
  is_active = true;

WITH free_plan AS (
  SELECT id FROM plans WHERE code = 'free'
), replaced_plans AS (
  SELECT id FROM plans WHERE code IN ('trial', 'starter')
), current_replacements AS (
  SELECT subscription.id
  FROM subscriptions AS subscription
  WHERE subscription.plan_id IN (SELECT id FROM replaced_plans)
    AND subscription.status IN ('trialing', 'active', 'past_due', 'paused')
)
UPDATE subscriptions AS subscription
SET
  plan_id = free_plan.id,
  status = 'active',
  current_period_start = date_trunc('month', now()),
  current_period_end = date_trunc('month', now()) + interval '1 month',
  trial_ends_at = NULL,
  messages_used = LEAST(subscription.messages_used, 1000),
  updated_at = now()
FROM free_plan
WHERE subscription.id IN (SELECT id FROM current_replacements);

UPDATE plans
SET is_active = false, updated_at = now()
WHERE code IN ('trial', 'starter');
