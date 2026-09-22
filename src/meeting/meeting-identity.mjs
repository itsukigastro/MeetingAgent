/**
 * How a Google Meet URL becomes a row in the Gastrobrain meetings table.
 *
 * The API keys meetings on `google_event_id` and upserts on it
 * (`../gastro/docs/MEETINGS_WEB.md` §6.2), because the intended caller is a
 * calendar watcher holding a real Calendar event id. Today the participant is
 * launched with a URL and nothing else, so it has to supply that key itself.
 *
 * Two properties are required of a synthesized key, and they pull in opposite
 * directions:
 *
 * - **Re-joining the same call must land on the same row.** The supervisor can
 *   crash, or be restarted by hand mid-meeting; a fresh key each time would
 *   split one meeting into several, each with a fragment of the transcript.
 * - **Tomorrow's standup on the same link must be a different row.** Recurring
 *   meetings reuse the Meet code forever, so the code alone would append every
 *   future standup to one ever-growing meeting.
 *
 * Meeting code + local calendar day satisfies both. The one case it gets wrong
 * is a meeting that crosses midnight, which splits in two; that is rare, and
 * the failure is legible (two adjacent meetings) rather than silent.
 */

import { normalizeGoogleMeetUrl } from "../providers/google-meet/google-meet-provider.mjs";

/** Company time. A key must not move when the server's TZ does. */
export const MEETING_TIME_ZONE = "Asia/Tokyo";

/** `2026-09-21` in the given zone. `en-CA` formats as ISO without a polyfill. */
export function localDay(now = new Date(), timeZone = MEETING_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The upsert key for a meeting joined by URL.
 *
 * Prefixed `meet:` so a synthesized key can never collide with a Calendar event
 * id, and so it is obvious in the database which meetings arrived without an
 * invite.
 */
export function meetingEventId(meetingUrl, now = new Date(), timeZone = MEETING_TIME_ZONE) {
  const { meetingKey } = normalizeGoogleMeetUrl(meetingUrl);
  return `meet:${meetingKey}:${localDay(now, timeZone)}`;
}

/**
 * A title from the Meet tab, or null to let the server name it.
 *
 * Meet titles the tab after the meeting when the event has a name and after the
 * code when it does not ("Meet — abc-defg-hij"). The second is worse than no
 * title at all: the server's fallback 「(無題の会議)」 at least reads as missing,
 * where a meeting code looks like a name and survives into the meetings list.
 */
export function titleFromMeetPageTitle(pageTitle, meetingUrl) {
  const raw = String(pageTitle || "")
    // Meet prefixes an unread count on the tab title.
    .replace(/^\(\d+\)\s*/, "")
    .trim();
  if (!raw) return null;

  let code = "";
  try {
    code = normalizeGoogleMeetUrl(meetingUrl).meetingKey;
  } catch {
    // An unparseable URL only costs us the code check below.
  }

  const withoutProduct = raw.replace(/^(?:Google\s+)?Meet\b[\s—–|-]*/i, "").trim();
  if (!withoutProduct) return null;
  if (code && withoutProduct.toLowerCase() === code) return null;
  return withoutProduct.slice(0, 500);
}
