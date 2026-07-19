import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    const parser = new PostalMime();
    const rawEmail = await new Response(message.raw).arrayBuffer();
    const parsed = await parser.parse(rawEmail);
    const providerMessageId =
      parsed.messageId || `sha256:${await sha256Hex(rawEmail)}`;

    const response = await fetch(env.BACKEND_INBOUND_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INBOUND_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${env.INBOUND_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        provider: 'cloudflare',
        from: message.from,
        to: message.to,
        subject: parsed.subject || '',
        text: parsed.text || '',
        messageId: providerMessageId,
        date: parsed.date || new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Backend inbound webhook failed with ${response.status}`);
    }
  },
};

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}
