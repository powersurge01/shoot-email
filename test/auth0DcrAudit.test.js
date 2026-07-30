import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDcrApplications } from '../src/auditAuth0Dcr.js';

test('DCR audit reports capacity and repeated callback families without deleting', () => {
  const result = auditDcrApplications([
    { name: 'First party', client_id: 'first_party', callbacks: [] },
    {
      name: 'Codex',
      client_id: 'tpc_one',
      callbacks: ['http://127.0.0.1:50001/callback/install-a'],
    },
    {
      name: 'Codex',
      client_id: 'tpc_two',
      callbacks: ['http://127.0.0.1:50002/callback/install-a'],
    },
  ], { warnAt: 2, failAt: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.level, 'warning');
  assert.equal(result.dynamicClientRegistrations, 2);
  assert.deepEqual(result.repeatedCallbackFamilies, [{
    fingerprint: 'install-a',
    clientIds: ['tpc_one', 'tpc_two'],
  }]);
  assert.match(result.guidance[0], /never deletes/);
});

test('DCR audit fails its policy threshold without mutating input', () => {
  const applications = [
    { client_id: 'tpc_one' },
    { client_id: 'tpc_two' },
    { client_id: 'tpc_three' },
  ];
  const original = structuredClone(applications);
  const result = auditDcrApplications(applications, { warnAt: 2, failAt: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.level, 'critical');
  assert.deepEqual(applications, original);
});
