import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeOpenAiAppsContext,
  serializeOpenAiContext,
} from '../src/openAiAppsContext.js';

test('normalizes OpenAI Apps _meta context', () => {
  const context = normalizeOpenAiAppsContext({
    _meta: {
      'openai/subject': 'subject-1',
      'openai/session': 'session-1',
      'openai/organization': 'organization-1',
    },
  });

  assert.deepEqual(context, {
    subject: 'subject-1',
    session: 'session-1',
    organization: 'organization-1',
  });
});

test('allows direct fields for local callers', () => {
  const context = normalizeOpenAiAppsContext({
    subject: 'subject-2',
    session: 'session-2',
    organization: 'organization-2',
  });

  assert.deepEqual(context, {
    subject: 'subject-2',
    session: 'session-2',
    organization: 'organization-2',
  });
});

test('serializes internal context without leaking provider identifiers', () => {
  const serialized = serializeOpenAiContext({
    user: {
      id: 'user-id',
      email_alias: 'u_12345678@in.test',
    },
    chatSession: {
      id: 'session-id',
      provider_session: 'provider-session-id',
    },
  });

  assert.deepEqual(serialized, {
    user: {
      id: 'user-id',
      emailAlias: 'u_12345678@in.test',
    },
    chatSession: {
      id: 'session-id',
      providerSession: 'provider-session-id',
    },
  });
});
