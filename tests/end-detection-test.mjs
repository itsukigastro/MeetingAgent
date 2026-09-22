#!/usr/bin/env node

/**
 * Deciding a meeting is over is the one judgement in this system that is worse
 * to get wrong in the eager direction: leaving a live call is visible to
 * everyone in it and cannot be undone within that meeting, while lingering in
 * a dead one costs a Realtime session.
 *
 * The case that drives the design is a Meet dialog. An `aria-modal` dialog
 * drops every role-based selector out of the accessibility tree (AGENTS.md
 * §8), so the leave button briefly "disappears" in a perfectly live call —
 * which is exactly what a naive detector would read as the end.
 */

import assert from "node:assert/strict";
import { POST_CALL_TEXT } from "../src/providers/google-meet/google-meet-provider.mjs";
import { createEndWatcher } from "../src/meeting/end-detection.mjs";

const inCall = { tabClosed: false, connection: "joined", onMeetingUrl: true, participants: 3 };
const postCall = { tabClosed: false, connection: "ended", onMeetingUrl: true, participants: null };

// --- nothing ends a call that is running -----------------------------------
let watcher = createEndWatcher();
for (let tick = 0; tick < 50; tick += 1) {
  assert.equal(watcher.observe(inCall).ended, false);
}

// --- before the AI is ever in the call, "not joined" is normal --------------
watcher = createEndWatcher();
for (let tick = 0; tick < 50; tick += 1) {
  assert.equal(
    watcher.observe({ ...postCall, connection: "waiting" }).ended,
    false,
    "waiting for admission is not the end of a meeting",
  );
}

// --- a modal blanking the controls must not end the meeting ----------------
watcher = createEndWatcher();
watcher.observe(inCall);
for (let tick = 0; tick < 5; tick += 1) {
  // "prejoin" is what the provider reports when the leave button cannot be
  // seen and no post-call wording is present — the dialog case.
  assert.equal(
    watcher.observe({ ...inCall, connection: "prejoin" }).ended,
    false,
    "a few ticks with no visible controls is a dialog, not the end",
  );
}
assert.equal(watcher.observe(inCall).ended, false);
for (let tick = 0; tick < 5; tick += 1) {
  assert.equal(watcher.observe({ ...inCall, connection: "prejoin" }).ended, false);
}
assert.equal(watcher.observe(inCall).ended, false, "and the streak resets when it comes back");

// --- the post-call screen, confirmed ---------------------------------------
watcher = createEndWatcher();
watcher.observe(inCall);
assert.equal(watcher.observe(postCall).ended, false, "one reading is not enough");
assert.equal(watcher.observe(postCall).ended, false);
const ended = watcher.observe(postCall);
assert.equal(ended.ended, true);
assert.match(ended.reason, /post-call/);

// --- the tab is gone: no confirmation needed -------------------------------
watcher = createEndWatcher();
const closed = watcher.observe({ ...inCall, tabClosed: true });
assert.equal(closed.ended, true);
assert.match(closed.reason, /closed/);

// --- navigated away from the meeting URL -----------------------------------
watcher = createEndWatcher();
watcher.observe(inCall);
watcher.observe({ ...inCall, connection: "prejoin", onMeetingUrl: false });
watcher.observe({ ...inCall, connection: "prejoin", onMeetingUrl: false });
assert.equal(
  watcher.observe({ ...inCall, connection: "prejoin", onMeetingUrl: false }).ended,
  true,
  "Meet's home screen after a call is unambiguous",
);

// --- alone in the call ------------------------------------------------------
watcher = createEndWatcher({ aloneTicks: 3 });
assert.equal(watcher.observe({ ...inCall, participants: 1 }).ended, false);
assert.equal(watcher.observe({ ...inCall, participants: 1 }).ended, false);
assert.equal(watcher.observe({ ...inCall, participants: 1 }).ended, true);

// Someone rejoining resets it, and an unreadable count is never a signal.
watcher = createEndWatcher({ aloneTicks: 3 });
watcher.observe({ ...inCall, participants: 1 });
watcher.observe({ ...inCall, participants: 2 });
for (let tick = 0; tick < 20; tick += 1) {
  assert.equal(watcher.observe({ ...inCall, participants: null }).ended, false);
}

// --- the weak signal, with its long grace ----------------------------------
watcher = createEndWatcher({ unjoinedGraceTicks: 4 });
watcher.observe(inCall);
assert.equal(watcher.observe({ ...inCall, connection: "unknown" }).ended, false);
assert.equal(watcher.observe({ ...inCall, connection: "unknown" }).ended, false);
assert.equal(watcher.observe({ ...inCall, connection: "unknown" }).ended, false);
const inferred = watcher.observe({ ...inCall, connection: "unknown" });
assert.equal(inferred.ended, true);
assert.match(inferred.reason, /no longer in the call/, "the reason says it was inferred");

process.stdout.write("End detection survives dialogs and still notices an empty call.\n");

for (const text of ["通話から退出しました", "この通話は終了しました", "You've left the meeting", "You have left the call", "The meeting has ended"]) assert.match(text, POST_CALL_TEXT);
