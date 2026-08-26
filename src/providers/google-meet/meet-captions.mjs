/**
 * Speaker-labelled transcript from Google Meet's live captions.
 *
 * Why captions and not the Realtime API's own transcription: the agent hears one
 * mixed audio stream, so its transcript has no speaker labels. Meet already did
 * the diarisation — it prints who is talking — and a 商談 summary is worth very
 * little without "the client asked" versus "we answered".
 *
 * Why this lives in Playwright rather than the Chrome extension: the extension
 * is deleted when the participant moves to a Linux VPS. The scraping logic is
 * identical either way, so it is hosted where it will still exist.
 *
 * ⚠️ Meet's markup is obfuscated and unstable. Everything version-specific is
 * confined to `CAPTION_REGION_SELECTORS` and the structural walk in
 * `collectorSource`, both written to degrade to "no captions" rather than to
 * wrong captions.
 */

/**
 * Where the caption text lives. Tried in order; the first that matches an
 * element containing text wins.
 *
 * Ordered most-stable-first: ARIA before anything class-based, because
 * `aria-*` is a contract with screen readers that Google is slow to break,
 * while class names are minified per release.
 */
export const CAPTION_REGION_SELECTORS = [
  '[role="region"][aria-label*="字幕"]',
  '[role="region"][aria-label*="aption"]',
  '[aria-label*="字幕"][aria-live]',
  '[aria-live="polite"][aria-atomic="false"]',
  // Last resort: Meet's long-lived caption container id.
  "div.a4cQT",
];

/** Buttons that switch captions on, by accessible name. */
export const CAPTION_ON_LABEL = /字幕をオン|字幕を有効|turn on captions|turn on subtitles/i;
export const CAPTION_OFF_LABEL = /字幕をオフ|字幕を無効|turn off captions|turn off subtitles/i;

/**
 * Browser-side collector, injected as a string.
 *
 * Meet rewrites a caption line in place as the speaker keeps talking, so an
 * entry is only final once its text stops changing. Lines are keyed by
 * speaker + the position of the node in the container, and flushed after
 * `settleMs` of no edits; the last version wins.
 *
 * Accumulates on `globalThis.__meetronCaptions` so a page reload loses at most
 * the un-flushed tail, and `drainMeetCaptions` can pull entries incrementally
 * without the collector needing a channel back to Node.
 */
export function collectorSource({ settleMs = 1_500, selectors = CAPTION_REGION_SELECTORS } = {}) {
  return `(() => {
  const SELECTORS = ${JSON.stringify(selectors)};
  const SETTLE_MS = ${JSON.stringify(settleMs)};

  if (globalThis.__meetronCaptions) return "already-installed";

  // \`flushed\` remembers the last text recorded per slot. Meet leaves a finished
  // caption on screen for several seconds after it settles, so without this the
  // next poll would treat the very same words as a new utterance.
  const state = {
    entries: [],
    pending: new Map(),
    flushed: new Map(),
    started: Date.now(),
    region: "",
  };
  globalThis.__meetronCaptions = state;

  const findRegion = () => {
    for (const selector of SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        if (node.innerText && node.innerText.trim()) {
          state.region = selector;
          return node;
        }
      }
    }
    return null;
  };

  // One caption line is "a speaker name and what they said". Meet nests both
  // inside a per-speaker block; the name is the shortest leaf, the words are
  // the rest. Read structurally rather than by class name, which is minified.
  const readLines = (region) => {
    const lines = [];
    for (const block of region.children) {
      const text = (block.innerText || "").trim();
      if (!text) continue;
      const parts = text.split("\\n").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      // A name is one short line; anything longer is already the speech.
      const named = parts.length > 1 && parts[0].length <= 40;
      lines.push({
        speaker: named ? parts[0] : "",
        text: (named ? parts.slice(1) : parts).join(" "),
      });
    }
    return lines;
  };

  const emit = (key, pending) => {
    if (!pending.text) return;
    state.entries.push({
      speaker: pending.speaker,
      text: pending.text,
      at: new Date(pending.startedAt).toISOString(),
    });
    // Bounded: keys are speaker + slot, so a meeting has few. The cap is a
    // backstop against a long call with many participants, not a real limit.
    if (state.flushed.size > 200) state.flushed.clear();
    state.flushed.set(key, pending.text);
  };

  const flush = (now) => {
    for (const [key, pending] of state.pending) {
      if (now - pending.updatedAt < SETTLE_MS) continue;
      state.pending.delete(key);
      emit(key, pending);
    }
  };

  const sample = () => {
    const region = findRegion();
    const now = Date.now();
    if (region) {
      readLines(region).forEach((line, index) => {
        const key = line.speaker + "#" + index;
        const previous = state.pending.get(key);
        if (previous) {
          // Unchanged: leave updatedAt alone so the line can age into settled.
          // Bumping it on every poll is what would keep a finished caption
          // pending forever, since Meet leaves it on screen.
          if (line.text === previous.text) return;
          if (line.text.startsWith(previous.text)) {
            previous.text = line.text;
            previous.updatedAt = now;
            return;
          }
          // Unrelated text in the same slot: the previous utterance is over.
          state.pending.delete(key);
          emit(key, previous);
        }
        // Still on screen but already recorded.
        if (state.flushed.get(key) === line.text) return;
        state.pending.set(key, {
          speaker: line.speaker,
          text: line.text,
          startedAt: now,
          updatedAt: now,
        });
      });
    }
    flush(now);
  };

  // Polling rather than a MutationObserver on the region: the region element is
  // replaced wholesale when captions are toggled, which detaches an observer
  // silently. A 500ms poll cannot be detached and costs nothing next to WebRTC.
  state.timer = setInterval(sample, 500);
  sample();
  return "installed";
})()`;
}

/** Install the collector. Idempotent — a second call is a no-op in the page. */
export async function installCaptionCollector(page, options = {}) {
  return page.evaluate(collectorSource(options));
}

/**
 * Turn captions on if they are not already.
 *
 * Best-effort by design: a meeting whose captions cannot be enabled should
 * still be joined, just without a transcript. Returns what happened so the
 * caller can report it rather than guess.
 */
export async function enableCaptions(page, locatorIsVisible) {
  const alreadyOn = page.getByRole("button", { name: CAPTION_OFF_LABEL });
  if (await locatorIsVisible(alreadyOn)) return { enabled: true, alreadyOn: true };

  const turnOn = page.getByRole("button", { name: CAPTION_ON_LABEL });
  if (!(await locatorIsVisible(turnOn))) return { enabled: false, alreadyOn: false };

  // `force` because Meet's control bar animates and a plain click times out on
  // "stable" — the same reason the microphone controls use it.
  await turnOn.first().click({ force: true, timeout: 5_000 }).catch(() => {});
  const confirmed = await alreadyOn
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  return { enabled: confirmed, alreadyOn: false };
}

/**
 * Take the finished caption entries and clear them from the page, so repeated
 * calls stream the transcript rather than re-reading it.
 */
export async function drainMeetCaptions(page) {
  return page.evaluate(() => {
    const state = globalThis.__meetronCaptions;
    if (!state) return { installed: false, entries: [], region: "" };
    const entries = state.entries.splice(0, state.entries.length);
    return { installed: true, entries, region: state.region, pending: state.pending.size };
  });
}
