INSERT INTO plans (
  code,
  name,
  description,
  monthly_message_limit,
  per_minute_message_limit,
  max_devices,
  max_api_keys,
  max_webhooks,
  retention_days,
  monthly_price_minor,
  currency,
  features,
  is_active
)
VALUES (
  'trial',
  'Trial',
  'A one-time 14-day evaluation with five message credits.',
  5,
  2,
  1,
  2,
  1,
  7,
  0,
  'LYD',
  '{"one_time": true, "trial_duration_days": 14, "message_credits": 5}'::jsonb,
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
  retention_days = EXCLUDED.retention_days,
  monthly_price_minor = EXCLUDED.monthly_price_minor,
  currency = EXCLUDED.currency,
  features = EXCLUDED.features,
  is_active = EXCLUDED.is_active;
