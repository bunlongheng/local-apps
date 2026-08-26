const { test } = require('node:test');
const assert = require('node:assert');
const makeHealth = require('../../lib/health');

function fresh() {
  const events = [];
  const h = makeHealth({ broadcast: (e) => events.push(e) });
  return { h, events };
}

test('getState creates and reuses per-id state', () => {
  const { h } = fresh();
  const a = h.getState('app1');
  assert.equal(a.status, 'unknown');
  a.status = 'up';
  assert.equal(h.getState('app1').status, 'up', 'same object returned');
  assert.notEqual(h.getState('app2'), a, 'different id -> different state');
});

test('clearState removes state', () => {
  const { h } = fresh();
  h.getState('gone').status = 'up';
  h.clearState('gone');
  assert.equal(h.getState('gone').status, 'unknown', 'recreated fresh after clear');
});

test('tcpCheck resolves false for an unreachable url (no throw)', async () => {
  const { h } = fresh();
  const up = await h.tcpCheck('http://127.0.0.1:1'); // nothing listens on port 1
  assert.equal(up, false);
});

test('checkSingle broadcasts an update on status change', async () => {
  const { h, events } = fresh();
  await h.checkSingle({ id: 'down-app', healthUrl: 'http://127.0.0.1:1' });
  assert.ok(events.some(e => e.type === 'update' && e.id === 'down-app' && e.status === 'down'));
});
