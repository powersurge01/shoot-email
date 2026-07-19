export function normalizeInboundPayload(payload) {
  return normalizeCloudflareInboundPayload(payload);
}

export function normalizeCloudflareInboundPayload(payload) {
  return {
    fromEmail: payload.from || payload.fromEmail || '',
    toEmail: payload.to || payload.toEmail || '',
    subject: payload.subject || '',
    textBody: payload.text || payload.textBody || '',
    providerMessageId: payload.messageId || payload.providerMessageId || null,
    receivedAt: parseDate(payload.date || payload.receivedAt),
  };
}

function parseDate(value) {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}
