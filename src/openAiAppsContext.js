const SUBJECT_KEY = 'openai/subject';
const SESSION_KEY = 'openai/session';
const ORGANIZATION_KEY = 'openai/organization';

export function normalizeOpenAiAppsContext(body = {}) {
  const meta = body._meta || {};

  return {
    subject: body.subject || meta[SUBJECT_KEY] || null,
    session: body.session || meta[SESSION_KEY] || null,
    organization: body.organization || meta[ORGANIZATION_KEY] || null,
  };
}

export function serializeOpenAiContext({ user, chatSession }) {
  return {
    user: {
      id: user.id,
      emailAlias: user.email_alias,
    },
    chatSession: chatSession
      ? {
          id: chatSession.id,
          providerSession: chatSession.provider_session,
        }
      : null,
  };
}
