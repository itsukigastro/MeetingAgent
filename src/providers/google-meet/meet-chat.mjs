/**
 * Commands and questions typed into Google Meet's chat.
 *
 * Why this exists at all: the wake word cannot be made reliable. Speech
 * recognition renders 商談AI as 昇段AI, 笑談え〜愛, 消壇AI and an open-ended tail
 * of others, and no alias list closes it. Rather than chase accuracy, the
 * requirement was removed — chat is a channel with *no transcription step*, so
 * 「商談AI 静かに」 typed into it is exact by construction.
 *
 * That makes chat the reliable path and speech the convenient one. It is the
 * in-meeting control surface (see `AGENTS.md` §5.2) and it is also how anyone
 * asks a question they need answered correctly the first time.
 *
 * Mirrors `meet-captions.mjs` deliberately: same injection strategy, same
 * polling, same drain-from-Node shape. Two differences, both because chat is
 * append-only where captions are rewritten in place:
 *
 *   1. No settle timer. A chat message is complete the moment it appears.
 *   2. A priming pass on install. The panel may already hold history, and
 *      replaying an hour-old 「商談AI 静かに」 on join would be baffling.
 *
 * ⚠️ Meet's markup is obfuscated and unstable. Everything version-specific is
 * confined to the selectors and the structural walk below, written to degrade
 * to "no messages" rather than to wrong messages.
 */

/**
 * Where chat messages live. Tried in order; the first that matches an element
 * containing text wins.
 *
 * Ordered most-stable-first: ARIA before anything class- or jsname-based,
 * because `aria-*` is a contract with screen readers that Google is slow to
 * break, while the rest is minified per release.
 */
export const CHAT_REGION_SELECTORS = [
  '[role="region"][aria-label*="チャット"]',
  '[role="region"][aria-label*="hat"]',
  '[aria-live="polite"][aria-label*="メッセージ"]',
  '[aria-live="polite"][aria-label*="essage"]',
  // Last resort: Meet's long-lived chat message list.
  'div[jsname="xySENc"]',
];

/** Buttons that open the chat panel, by accessible name. */
export const CHAT_OPEN_LABEL = /チャット|全員とチャット|chat with everyone|open chat/i;
/** Present only while the panel is already open. */
export const CHAT_CLOSE_LABEL = /チャットを閉じる|close chat/i;

/**
 * A timestamp line inside a message block. Dropped before the sender is
 * guessed, because Meet puts the time next to the name and it would otherwise
 * be mistaken for the message body.
 */
const TIME_LINE = /^(?:午前|午後)?\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;

/**
 * Browser-side collector, injected as a string.
 *
 * Accumulates on `globalThis.__meetronChat` so a reload loses at most the tail,
 * and `drainMeetChat` can pull messages incrementally without the collector
 * needing a channel back to Node.
 */
export function collectorSource({ pollMs = 500, selectors = CHAT_REGION_SELECTORS } = {}) {
  return `(() => {
  const SELECTORS = ${JSON.stringify(selectors)};
  const POLL_MS = ${JSON.stringify(pollMs)};
  const TIME_LINE = ${TIME_LINE.toString()};

  if (globalThis.__meetronChat) return "already-installed";

  const state = {
    messages: [],
    // Keys already emitted. Chat is append-only, so index is a stable part of
    // the key and two identical messages from one person stay distinct.
    seen: new Set(),
    primed: false,
    region: "",
  };
  globalThis.__meetronChat = state;

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

  // Meet tags every message with a stable unique id, and that element holds
  // the body *alone* — no sender, no timestamp. Prefer it over any structural
  // guess.
  //
  // Found in the first live meeting, 2026-09-21: the real group's innerText
  // arrives with no newlines at all — "孫イツキ10:37 AM商談AI 起きて" — so the
  // line-splitting walk below produced a single contaminated string with an
  // empty sender. parseChatCommand then saw the wake word at position 12
  // rather than 0, failed closed as designed, and the agent sat asleep while
  // the operator watched a message it had genuinely received. The synthetic
  // test could not have caught this: it built the newline-separated shape the
  // walk expected.
  const readTagged = (region) => {
    const out = [];
    for (const node of region.querySelectorAll("[data-message-id]")) {
      const text = (node.innerText || "").trim();
      if (!text) continue;
      out.push({ id: node.getAttribute("data-message-id"), node, text });
    }
    return out;
  };

  // The sender sits on the enclosing group, in a leaf that belongs to no
  // message and is not the clock. Walk outwards until one turns up.
  const senderFor = (node, region) => {
    let el = node.parentElement;
    while (el && el !== region) {
      for (const leaf of el.querySelectorAll("*")) {
        if (leaf.children.length) continue;
        if (leaf.closest("[data-message-id]")) continue;
        const text = (leaf.innerText || "").trim();
        if (!text || TIME_LINE.test(text)) continue;
        return text;
      }
      el = el.parentElement;
    }
    return "";
  };

  // Fallback for a Meet that stops tagging messages. One block is "who sent
  // it, when, and what they wrote", read structurally rather than by class
  // name, which is minified. Meet groups consecutive messages from the same
  // person, so a block can hold several lines of body.
  const readMessages = (region) => {
    const out = [];
    for (const block of region.children) {
      const raw = (block.innerText || "").trim();
      if (!raw) continue;
      const parts = raw
        .split("\\n")
        .map((p) => p.trim())
        .filter((p) => p && !TIME_LINE.test(p));
      if (parts.length === 0) continue;
      // A name is one short line; anything longer is already the message.
      const named = parts.length > 1 && parts[0].length <= 40;
      const sender = named ? parts[0] : "";
      for (const text of named ? parts.slice(1) : parts) {
        out.push({ sender, text });
      }
    }
    return out;
  };

  const sample = () => {
    const region = findRegion();
    if (!region) return;
    const now = new Date().toISOString();

    const tagged = readTagged(region);
    if (tagged.length) {
      for (const message of tagged) {
        // The id deduplicates exactly, so two people sending identical words —
        // or one person repeating themselves — stay separate messages without
        // the index hack the structural path needs.
        if (state.seen.has(message.id)) continue;
        state.seen.add(message.id);
        if (!state.primed) continue;
        state.messages.push({
          sender: senderFor(message.node, region),
          text: message.text,
          at: now,
        });
      }
      state.primed = true;
      return;
    }

    readMessages(region).forEach((message, index) => {
      const key = index + "\\u0000" + message.sender + "\\u0000" + message.text;
      if (state.seen.has(key)) return;
      state.seen.add(key);
      // First pass records what was already on screen without acting on it —
      // joining a meeting must not replay the chat history as fresh commands.
      if (!state.primed) return;
      state.messages.push({ sender: message.sender, text: message.text, at: now });
    });

    state.primed = true;
  };

  // Exposed so a drain can take a fresh reading first. Without it a message
  // typed in the gap between polls waits up to POLL_MS to be seen, which for a
  // command means the agent looks like it ignored you.
  state.sample = sample;

  // Polling rather than a MutationObserver: the panel is torn down and rebuilt
  // when chat is closed and reopened, which detaches an observer silently.
  state.timer = setInterval(sample, POLL_MS);
  sample();
  return "installed";
})()`;
}

/** Install the collector. Idempotent — a second call is a no-op in the page. */
export async function installChatCollector(page, options = {}) {
  return page.evaluate(collectorSource(options));
}

/**
 * Open the chat panel, and leave it open.
 *
 * Not cosmetic: Meet does not render messages into the DOM while the panel is
 * closed, so without this the collector polls an empty page and the control
 * surface silently does not exist.
 *
 * Best-effort by design — a meeting whose chat cannot be opened should still be
 * joined, just without typed control. Returns what happened so the caller can
 * report it rather than guess.
 */
export async function openChatPanel(page, locatorIsVisible) {
  const alreadyOpen = page.getByRole("button", { name: CHAT_CLOSE_LABEL });
  if (await locatorIsVisible(alreadyOpen)) return { open: true, alreadyOpen: true };

  const openChat = page.getByRole("button", { name: CHAT_OPEN_LABEL });
  if (!(await locatorIsVisible(openChat))) return { open: false, alreadyOpen: false };

  // `force` because Meet's control bar animates and a plain click times out on
  // "stable" — the same reason the microphone and caption controls use it.
  await openChat.first().click({ force: true, timeout: 5_000 }).catch(() => {});
  const confirmed = await alreadyOpen
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  return { open: confirmed, alreadyOpen: false };
}

/**
 * Take the messages that have arrived and clear them from the page, so repeated
 * calls stream the chat rather than re-reading it.
 *
 * Samples the DOM before reading, so a drain always reflects what is on screen
 * *now* rather than as of the last poll tick.
 */
export async function drainMeetChat(page) {
  return page.evaluate(() => {
    const state = globalThis.__meetronChat;
    if (!state) return { installed: false, messages: [], region: "" };
    state.sample?.();
    const messages = state.messages.splice(0, state.messages.length);
    return { installed: true, messages, region: state.region };
  });
}
