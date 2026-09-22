#!/usr/bin/env node

/**
 * The queue is the only copy of a caption line: draining the page is
 * destructive, so anything dropped here is gone from the transcript. These
 * tests pin the three properties the API depends on — monotonic `seq` across a
 * restart, a failed batch surviving in order, and a bound that a dead backend
 * cannot grow past.
 */

import assert from "node:assert/strict";
import { createSegmentQueue, MAX_BATCH } from "../src/meeting/segment-queue.mjs";

const entry = (text, speaker = "田中") => ({
  speaker,
  text,
  at: "2026-09-21T01:00:00.000Z",
});

// --- seq -------------------------------------------------------------------
const queue = createSegmentQueue();
assert.equal(queue.push([entry("おはようございます"), entry("楽天の件です")]), 2);
assert.deepEqual(
  queue.take().map((s) => s.seq),
  [1, 2],
);

// The server dedupes on (meeting_id, seq) with ON CONFLICT DO NOTHING, so a
// counter that restarted at 0 would not overwrite — it would silently discard
// the rest of the meeting.
const resumed = createSegmentQueue({ startSeq: 2 });
resumed.push([entry("続きです")]);
assert.deepEqual(
  resumed.take().map((s) => s.seq),
  [3],
);

// --- shape and clamping ----------------------------------------------------
const shaped = createSegmentQueue();
shaped.push([entry("こんにちは", "佐藤")]);
const [segment] = shaped.take();
assert.deepEqual(segment, {
  seq: 1,
  speaker: "佐藤",
  text: "こんにちは",
  spoken_at: "2026-09-21T01:00:00.000Z",
});

const clamped = createSegmentQueue();
clamped.push([{ speaker: "あ".repeat(500), text: "い".repeat(20_000) }], new Date("2026-09-21T02:00:00.000Z"));
const [long] = clamped.take();
assert.equal(long.speaker.length, 200, "speaker is clamped to the column width");
assert.equal(long.text.length, 10_000, "text is clamped to the column width");
assert.equal(long.spoken_at, "2026-09-21T02:00:00.000Z", "an entry with no timestamp gets now");

// Meet emits blank slots; a blank line costs a seq and adds nothing.
const blanks = createSegmentQueue();
assert.equal(blanks.push([entry("  "), entry(""), entry("実質1行")]), 1);
assert.equal(blanks.seq, 1);

// --- batching and retry ----------------------------------------------------
const many = createSegmentQueue();
many.push(Array.from({ length: MAX_BATCH + 10 }, (_, i) => entry(`line ${i}`)));
const first = many.take();
assert.equal(first.length, MAX_BATCH, "one request never exceeds the server's cap");
assert.equal(many.size, 10);

many.requeue(first);
assert.equal(many.size, MAX_BATCH + 10, "a failed batch is not lost");
assert.deepEqual(
  many.take().slice(0, 3).map((s) => s.seq),
  [1, 2, 3],
  "and it goes back at the front, in order",
);

// --- bounded ---------------------------------------------------------------
const bounded = createSegmentQueue({ maxQueued: 5 });
bounded.push(Array.from({ length: 8 }, (_, i) => entry(`line ${i}`)));
assert.equal(bounded.size, 5, "a backend that never recovers cannot grow the process");
assert.equal(bounded.dropped, 3);
assert.deepEqual(
  bounded.take().map((s) => s.seq),
  [4, 5, 6, 7, 8],
  "the oldest go first — the end of a meeting matters more to a summary",
);
assert.equal(bounded.accepted, 8, "what was captured is still counted after a drop");

process.stdout.write("Segment queue keeps seq monotonic, retries in order, and stays bounded.\n");

// A restart replays unacknowledged segments with the same sequence numbers.
const crashed = createSegmentQueue();
crashed.push([entry("before crash")]);
const recovered = createSegmentQueue({ startSeq: crashed.snapshot().seq, pending: crashed.snapshot().pending });
recovered.push([entry("after restart")]);
assert.deepEqual(recovered.take().map(s => [s.seq, s.text]), [[1, "before crash"], [2, "after restart"]]);
