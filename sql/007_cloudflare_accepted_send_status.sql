UPDATE messages
SET delivery_status = 'queued',
    delivery_error_code = NULL,
    delivery_error_message = NULL
WHERE direction = 'outbound'
  AND delivery_provider = 'cloudflare'
  AND delivery_status = 'unknown'
  AND provider_message_id IS NOT NULL
  AND delivery_error_code IS NULL;
