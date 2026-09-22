import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRunStore } from '../src/meeting/run-state.mjs';
const directory = mkdtempSync(join(tmpdir(), 'meeting-state-'));
try {
  let store = openRunStore(directory);
  assert.equal(store.read(), null);
  assert.throws(() => openRunStore(directory), /already running/);
  const state = { meetingId: 'm1', seq: 12, pending: [{ seq: 12, text: 'pending' }], endedAt: null };
  store.write(state);
  assert.equal(statSync(join(directory, 'meeting-session.json')).mode & 0o777, 0o600);
  store.close();
  store = openRunStore(directory);
  assert.deepEqual(store.read(), state);
  writeFileSync(join(directory, 'meeting-session.json'), '{broken');
  assert.throws(() => store.read(), /recovery state/);
  store.close();
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log('Run state persists pending segments and rejects concurrent supervisors.');
