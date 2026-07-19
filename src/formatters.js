export function formatMessageRow(message) {
  const timestamp = message.received_at || message.sent_at || message.created_at;
  return [
    message.id,
    timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
    message.from_email,
    message.subject || '(no subject)',
  ].join('  ');
}

export function formatMessage(message) {
  const timestamp = message.received_at || message.sent_at || message.created_at;

  return [
    `ID: ${message.id}`,
    `Direction: ${message.direction}`,
    `From: ${message.from_email}`,
    `To: ${message.to_email}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `Timestamp: ${new Date(timestamp).toISOString()}`,
    '',
    message.text_body || '',
  ].join('\n');
}
