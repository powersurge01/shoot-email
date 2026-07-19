CREATE UNIQUE INDEX IF NOT EXISTS messages_user_inbound_provider_message_key
  ON messages(user_id, provider_message_id)
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL;
