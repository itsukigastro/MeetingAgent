/**
 * Deciding that a meeting is over.
 *
 * This is the judgement call the participant never used to make: teardown only
 * ever happened because a human pressed 終了 in the extension panel, so when the
 * humans hung up the AI sat in the empty call until somebody noticed.
 *
 * The two failure modes are not symmetric. Leaving a live meeting is visible,
 * embarrassing and unrecoverable within that meeting; lingering in a dead one
 * costs a Realtime session and a late summary. So every signal except a closed
 * tab has to hold for several consecutive observations, and the weakest signal
 * — "the leave button is not there" — is given a long grace period, because a
 * Meet dialog blanks role-based selectors outright (AGENTS.md §8) and would
 * otherwise read as "the call ended" a few seconds later.
 *
 * Pure: one observation in, a verdict out. The supervisor does the DOM reading.
 */

/** Ticks a signal must persist before it is believed. Three consecutive observations. */
export const CONFIRM_TICKS = 3;

/** Not joined, but nothing says the call ended either. ~60 s at a 3 s tick. */
export const UNJOINED_GRACE_TICKS = 20;

/** Alone in the call. ~120 s at a 3 s tick. */
export const ALONE_TICKS = 40;

/**
 * @typedef {object} MeetObservation
 * @property {boolean} tabClosed      the Meet tab is gone
 * @property {string}  connection     provider status: joined | ended | prejoin | …
 * @property {boolean} onMeetingUrl   still on /xxx-yyyy-zzz, not Meet's home
 * @property {number|null} participants  people in the call, null when unreadable
 */

export function createEndWatcher({
  confirmTicks = CONFIRM_TICKS,
  unjoinedGraceTicks = UNJOINED_GRACE_TICKS,
  aloneTicks = ALONE_TICKS,
} = {}) {
  // Nothing is believed until the participant has actually been in the call:
  // before that, "not joined" is the normal state, not the end of a meeting.
  let joinedOnce = false;
  const streaks = { ended: 0, offMeetingUrl: 0, unjoined: 0, alone: 0 };

  return {
    /**
     * @param {MeetObservation} observation
     * @returns {{ended: boolean, reason: string}}
     */
    observe({ tabClosed, connection, onMeetingUrl, participants }) {
      // No tab, no meeting. This is the one signal with no ambiguity, and it is
      // also how a session ends when Chrome or the whole machine goes away.
      if (tabClosed) return { ended: true, reason: "the Meet tab was closed" };

      if (connection === "joined") {
        joinedOnce = true;
        streaks.ended = 0;
        streaks.offMeetingUrl = 0;
        streaks.unjoined = 0;
        streaks.alone = participants === 1 ? streaks.alone + 1 : 0;

        if (streaks.alone >= aloneTicks) {
          return { ended: true, reason: `alone in the call for ${streaks.alone} ticks` };
        }
        return { ended: false, reason: "" };
      }

      streaks.alone = 0;
      if (!joinedOnce) {
        // Still getting in — waiting for admission, or a slow pre-join screen.
        return { ended: false, reason: "" };
      }

      streaks.ended = connection === "ended" ? streaks.ended + 1 : 0;
      streaks.offMeetingUrl = onMeetingUrl ? 0 : streaks.offMeetingUrl + 1;
      streaks.unjoined += 1;

      if (streaks.ended >= confirmTicks) {
        return { ended: true, reason: "Meet is showing its post-call screen" };
      }
      if (streaks.offMeetingUrl >= confirmTicks) {
        return { ended: true, reason: "the tab left the meeting URL" };
      }
      if (streaks.unjoined >= unjoinedGraceTicks) {
        // The weak one. Long grace, and the reason says it is inferred, so a
        // wrong call here is recognisable in the log rather than mysterious.
        return {
          ended: true,
          reason: `no longer in the call for ${streaks.unjoined} ticks (connection=${connection})`,
        };
      }
      return { ended: false, reason: "" };
    },
  };
}
