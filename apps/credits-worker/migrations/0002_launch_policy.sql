INSERT INTO pricing_policies
  (version, ratio, apple_commission, openrouter_fee, credits_per_usd, effective_from)
SELECT 1, '1', '0.15', '0.055', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM pricing_policies);
