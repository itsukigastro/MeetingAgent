#!/usr/bin/env node

/**
 * Carry Meet chat messages to the agent, for the length of the meeting.
 *
 * The two halves of the participant live in two tabs that cannot see each
 * other: the meeting is on `meet.google.com` and the agent is the Gastrobrain
 * `/voice?mode=meeting` page. Chat arrives in the first; the thing that can act
 * on it is in the second. This process is the wire between them.
 *
 * It is deliberately its own script rather than a branch of `native-host.mjs`.
 * The native host is deleted when the participant moves to a Linux VPS
 * (AGENTS.md §5.0); this is plain Playwright over CDP and ports unchanged.
 *
 * The page owns the meaning of a message, not this script. Everything here does
 * is hand the raw text to `window.meetingControl.command(text)` and log what
 * came back — the wake-word aliases, the 「静かに」 matching and the decision to
 * ignore a message are all in `meeting-mode.ts`, next to the state they change
 * and covered by its tests.
 */

import { connectToChromeOverCDP } from "./playwright-cdp.mjs";
import { locatorIsVisible } from "../src/browser/meeting-browser.mjs";
import {
  drainMeetChat,
  installChatCollector,
  openChatPanel,
} from "../src/providers/google-meet/meet-chat.mjs";

const MEET_ORIGIN = "https://meet.google.com/";

const options = {
  cdp: "http://127.0.0.1:9223",
  agentUrl: "",
  pollMs: 1_000,
  once: false,
};

function usage() {
  process.stdout.write(
    `Usage: node scripts/meet-chat-bridge.mjs --agent-url URL [options]\n\n` +
      `Options:\n` +
      `  --cdp URL          Chrome DevTools endpoint (default: ${options.cdp})\n` +
      `  --agent-url URL    Gastrobrain voice URL, to find the agent tab\n` +
      `  --poll MS          How often to drain chat (default: ${options.pollMs})\n` +
      `  --once             Drain once and exit. For tests and diagnostics.\n` +
      `  -h, --help         Show this help\n`,
  );
}

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  switch (args[index]) {
    case "--cdp":
      options.cdp = args[++index] || "";
      break;
    case "--agent-url":
      options.agentUrl = args[++index] || "";
      break;
    case "--poll":
      options.pollMs = Number(args[++index]);
      break;
    case "--once":
      options.once = true;
      break;
    case "-h":
    case "--help":
      usage();
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown argument: ${args[index]}\n`);
      usage();
      process.exit(2);
  }
}

let agentOrigin;
try {
  agentOrigin = new URL(options.agentUrl).origin;
} catch {
  process.stderr.write(`--agent-url must be a URL: ${options.agentUrl}\n`);
  process.exit(2);
}

const pagesOn = (browser, prefix) =>
  browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().startsWith(prefix));

const browser = await connectToChromeOverCDP(options.cdp);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  const meetPage = pagesOn(browser, MEET_ORIGIN)[0];
  if (!meetPage) throw new Error("No Google Meet tab is open in the dedicated Chrome.");
  const agentPage = pagesOn(browser, agentOrigin)[0];
  if (!agentPage) throw new Error(`No agent tab is open on ${agentOrigin}.`);

  // Both are idempotent. `prepare-meet.mjs` normally did this on join, but the
  // bridge can be started against a meeting that is already running — after a
  // crash, or by hand while debugging — and must work either way.
  const panel = await openChatPanel(meetPage, locatorIsVisible);
  const collector = await installChatCollector(meetPage);
  process.stdout.write(
    `[chat] panel ${panel.open ? "open" : "unavailable"}, collector ${collector}\n`,
  );

  let delivered = 0;
  do {
    const { installed, messages, region } = await drainMeetChat(meetPage);
    if (!installed) throw new Error("The chat collector is not installed in the meeting tab.");

    for (const message of messages) {
      // One round trip per message. Chat volume in a meeting is a few messages
      // a minute, so this stays far cheaper than the polling that found them.
      const outcome = await agentPage.evaluate(
        (text) => globalThis.meetingControl?.command(text) ?? "no-control",
        message.text,
      );
      if (outcome !== "ignored") delivered += 1;
      process.stdout.write(
        `[chat] ${message.sender || "?"}: ${message.text} → ${outcome}\n`,
      );
    }

    if (options.once) {
      process.stdout.write(
        `[chat] drained once: ${messages.length} message(s), ${delivered} acted on, region ${region || "none"}\n`,
      );
      break;
    }

    await meetPage.waitForTimeout(options.pollMs);
    // A closed tab is the normal end of a meeting, not a failure.
  } while (!stopping && !meetPage.isClosed() && !agentPage.isClosed());
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // Detach from CDP without closing the browser — the meeting is running in it.
  await browser.close().catch(() => {});
}
