import assert from 'node:assert/strict';
import test from 'node:test';
import { isReservedAlias, normalizeCustomAlias } from '../src/aliasPolicy.js';

test('normalizes valid custom aliases', () => {
  assert.deepEqual(normalizeCustomAlias('  Took-Talent-0r  ', 'YOYOWZA.COM'), {
    localPart: 'took-talent-0r',
    email: 'took-talent-0r@yoyowza.com',
  });
});

test('rejects reserved roles, brands, and obvious variants', () => {
  for (const alias of [
    'admin',
    'admin-1',
    'supp_ort',
    'support-team',
    'mailer-daemon',
    'openai-support',
    'Cloudflare_Official',
    'yoyowza-mail',
    'u_deadbeef',
  ]) {
    assert.equal(isReservedAlias(alias), true, alias);
    assert.throws(
      () => normalizeCustomAlias(alias, 'yoyowza.com'),
      (error) => error.code === 'reserved_alias',
    );
  }
});

test('rejects unsafe alias syntax and non-ASCII lookalikes', () => {
  for (const alias of ['ab', 'a@b', '.alias', 'alias-', 'two--parts', 'paypаl']) {
    assert.throws(
      () => normalizeCustomAlias(alias, 'yoyowza.com'),
      (error) => error.code === 'invalid_alias',
      alias,
    );
  }
});
