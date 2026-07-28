import assert from 'node:assert/strict';
import test from 'node:test';

import { getConfig, runWithConfigEnvironment } from '../src/config.js';

test('Worker request bindings override process environment configuration', async () => {
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'process-account';

  try {
    const config = await runWithConfigEnvironment({
      CLOUDFLARE_ACCOUNT_ID: 'worker-account',
      CLOUDFLARE_EMAIL_API_TOKEN: 'worker-secret',
      OUTBOUND_SENDING_ENABLED: 'false',
    }, async () => getConfig());

    assert.equal(config.cloudflareAccountId, 'worker-account');
    assert.equal(config.cloudflareApiToken, 'worker-secret');
    assert.equal(config.outboundAbuse.enabled, false);
  } finally {
    restoreEnvironment('CLOUDFLARE_ACCOUNT_ID', previousAccountId);
  }
});

test('concurrent Worker request configuration remains isolated', async () => {
  const readConfigAfterYield = (accountId) => runWithConfigEnvironment({
    CLOUDFLARE_ACCOUNT_ID: accountId,
  }, async () => {
    await Promise.resolve();
    return getConfig().cloudflareAccountId;
  });

  const [first, second] = await Promise.all([
    readConfigAfterYield('first-account'),
    readConfigAfterYield('second-account'),
  ]);

  assert.equal(first, 'first-account');
  assert.equal(second, 'second-account');
});

test('configuration falls back to process environment outside a Worker request', () => {
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'local-account';

  try {
    assert.equal(getConfig().cloudflareAccountId, 'local-account');
  } finally {
    restoreEnvironment('CLOUDFLARE_ACCOUNT_ID', previousAccountId);
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
