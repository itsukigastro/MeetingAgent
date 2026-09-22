#!/usr/bin/env node

/**
 * The upsert key has to hold two properties at once: a restart mid-meeting
 * rejoins the same row, and tomorrow's standup on the same recurring link is a
 * different one. Both are asserted here, because getting either wrong is
 * invisible until a transcript is split or two meetings are merged.
 */

import assert from "node:assert/strict";
import {
  localDay,
  meetingEventId,
  titleFromMeetPageTitle,
} from "../src/meeting/meeting-identity.mjs";

const url = "https://meet.google.com/abc-defg-hij";
const morning = new Date("2026-09-21T01:00:00.000Z"); // 10:00 JST
const evening = new Date("2026-09-21T09:30:00.000Z"); // 18:30 JST, same JST day
const tomorrow = new Date("2026-09-22T01:00:00.000Z");

assert.equal(meetingEventId(url, morning), "meet:abc-defg-hij:2026-09-21");
assert.equal(
  meetingEventId(url, evening),
  meetingEventId(url, morning),
  "a restart later the same day must resume the same meeting",
);
assert.notEqual(
  meetingEventId(url, tomorrow),
  meetingEventId(url, morning),
  "the same recurring link tomorrow is a different meeting",
);

// 2026-09-21T15:30Z is already the 22nd in Tokyo. The key must follow company
// time, not the machine's, or a late meeting lands on the wrong day.
assert.equal(localDay(new Date("2026-09-21T15:30:00.000Z")), "2026-09-22");
assert.equal(localDay(new Date("2026-09-21T14:30:00.000Z")), "2026-09-21");

assert.notEqual(
  meetingEventId("https://meet.google.com/zzz-zzzz-zzz", morning),
  meetingEventId(url, morning),
  "two calls on the same day are two meetings",
);

assert.throws(() => meetingEventId("https://example.com/not-a-meeting"));

// Titles: a real name is kept, Meet's own "product — code" tab title is not.
// A meeting code that looks like a name would survive into the meetings list,
// where it is worse than the server's 「(無題の会議)」 fallback.
assert.equal(titleFromMeetPageTitle("週次定例 - Google Meet", url), "週次定例 - Google Meet");
assert.equal(titleFromMeetPageTitle("Meet — abc-defg-hij", url), null);
assert.equal(titleFromMeetPageTitle("Google Meet", url), null);
assert.equal(titleFromMeetPageTitle("(3) Meet - abc-defg-hij", url), null);
assert.equal(titleFromMeetPageTitle("Meet - 経営会議", url), "経営会議");
assert.equal(titleFromMeetPageTitle("", url), null);
assert.equal(titleFromMeetPageTitle(null, url), null);
assert.equal(titleFromMeetPageTitle("経営会議", "not-a-url"), "経営会議");

process.stdout.write("Meeting identity keys resume a restart and separate a recurrence.\n");
