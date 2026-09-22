/**
 * Caption lines on their way to the API.
 *
 * Between the collector in the Meet tab and `POST /v1/meetings/{id}/segments`
 * sit three requirements that are easier to get right in one small, pure module
 * than inline in the supervisor's poll loop:
 *
 * 1. **`seq` is ours to allocate.** The server dedupes on `(meeting_id, seq)`
 *    and nothing else, so the sequence must be monotonic per meeting and must
 *    survive a supervisor restart — a counter that resets would silently
 *    overwrite nothing and drop everything, since the insert is
 *    `ON CONFLICT DO NOTHING`.
 * 2. **A failed post must not lose the batch.** The lines are already gone from
 *    the page (draining is destructive), so this queue is the only copy.
 * 3. **It must be bounded.** A backend that is down for an hour must not grow
 *    the process until it dies; a meeting transcript is worth less than the
 *    meeting.
 *
 * No I/O here, so the whole policy is testable without a browser or a server.
 */

/** The server's own cap on one request (`SegmentsBody`). */
export const MAX_BATCH = 500;

/** ~3 hours of dense conversation. Past this the backend is not coming back. */
export const MAX_QUEUED = 5_000;

/** Server-side column limits; over-long values are rejected, not truncated. */
const MAX_SPEAKER_CHARS = 200;
const MAX_TEXT_CHARS = 10_000;

export function createSegmentQueue({
  startSeq = 0,
  pending = [],
  maxBatch = MAX_BATCH,
  maxQueued = MAX_QUEUED,
} = {}) {
  let seq = Math.max(startSeq, ...pending.map((segment) => segment.seq));
  let dropped = 0;
  let accepted = 0;
  let queue = pending.slice(-maxQueued);

  return {
    /**
     * Take caption entries (`{speaker, text, at}`) and turn them into segments.
     *
     * Empty text is skipped rather than queued: Meet emits the occasional blank
     * slot, and a blank line costs a `seq` and adds nothing to the summary.
     */
    push(entries, now = new Date()) {
      let added = 0;
      for (const entry of entries ?? []) {
        const text = String(entry?.text ?? "").trim();
        if (!text) continue;
        seq += 1;
        accepted += 1;
        added += 1;
        queue.push({
          seq,
          speaker: String(entry?.speaker ?? "").slice(0, MAX_SPEAKER_CHARS),
          text: text.slice(0, MAX_TEXT_CHARS),
          spoken_at: entry?.at || now.toISOString(),
        });
      }
      if (queue.length > maxQueued) {
        // Drop the oldest: in a summary the recent half of a meeting is worth
        // more than its opening, and the drop is counted so it is visible.
        const overflow = queue.length - maxQueued;
        queue = queue.slice(overflow);
        dropped += overflow;
      }
      return added;
    },

    /** The next batch to send. Removed from the queue — see {@link requeue}. */
    take() {
      return queue.splice(0, maxBatch);
    },

    /** Put a failed batch back at the front, keeping `seq` order intact. */
    requeue(batch) {
      if (!batch?.length) return;
      queue = [...batch, ...queue];
      if (queue.length > maxQueued) {
        const overflow = queue.length - maxQueued;
        queue = queue.slice(overflow);
        dropped += overflow;
      }
    },

    get size() {
      return queue.length;
    },
    snapshot() {
      return { seq, pending: queue.slice() };
    },
    /** Last allocated `seq`. Persisted across restarts by the supervisor. */
    get seq() {
      return seq;
    },
    get dropped() {
      return dropped;
    },
    /** Lines accepted from the page, ever. Zero after a minute means the
     * caption selectors no longer match Meet — the known §7 risk. */
    get accepted() {
      return accepted;
    },
  };
}
