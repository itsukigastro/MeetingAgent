import assert from 'node:assert/strict';
import { createStateSync } from '../src/meeting/state-sync.mjs';
const sync = createStateSync();
const applied = [];
const pushed = [];
let ready = true;
const tick = (remote, local) => sync.sync({ remote, local,
  apply: async value => { if (!ready) return false; applied.push(value); return true; },
  push: async value => { pushed.push(value); return true; },
});
await tick('asleep', 'asleep');
await tick('asleep', 'open');
assert.deepEqual(pushed, ['open']);
await tick('open', 'open');
await tick('asleep', 'open'); // UI quiet while the local sample is still awake.
assert.deepEqual(applied, ['asleep']);
assert.deepEqual(pushed, ['open'], 'no echo of stale sample');
await tick('asleep', 'asleep');
ready = false;
await tick('open', 'asleep');
ready = true;
await tick('open', 'asleep');
assert.deepEqual(applied, ['asleep', 'open'], 'unready page retries remote application');
await tick('open', 'asleep'); // Local idle expiry, no remote edge.
assert.deepEqual(pushed, ['open', 'asleep']);
console.log('Meeting state sync preserves web commands and local idle expiry.');
