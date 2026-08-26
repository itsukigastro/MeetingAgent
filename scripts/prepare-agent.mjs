#!/usr/bin/env node

/**
 * Open the Gastrobrain voice agent in the dedicated Chrome and wait for it to
 * come up.
 *
 * Replaces `prepare-chatgpt-live.mjs` (542 LOC of ChatGPT DOM automation). That
 * script had to drive someone else's web app by clicking buttons whose labels
 * it did not control. We own this page, so it reports its own state on
 * `document.documentElement.dataset.meetingStatus`, and this script only has to
 * open a tab and read one attribute.
 *
 * Exit codes follow the convention the launcher already expects:
 *   0   the agent is live
 *   10  not signed in to Gastrobrain — a human must log in once
 *   1   anything else
 */

import { connectToChromeOverCDP } from "./playwright-cdp.mjs";

const EXIT_NEEDS_LOGIN = 10;

const options = {
  cdp: "http://127.0.0.1:9223",
  agentUrl: "",
  replaceTab: false,
  timeoutMs: 90_000,
};

function usage() {
  process.stdout.write(
    `Usage: node scripts/prepare-agent.mjs [options]\n\n` +
      `Options:\n` +
      `  --cdp URL          Chrome DevTools endpoint (default: ${options.cdp})\n` +
      `  --agent-url URL    Gastrobrain voice URL (must include mode=meeting)\n` +
      `  --replace-tab      Close existing agent tabs first, leaving the meeting tab alone\n` +
      `  --timeout MS       How long to wait for the agent to go live (default: ${options.timeoutMs})\n` +
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
    case "--replace-tab":
      options.replaceTab = true;
      break;
    case "--timeout":
      options.timeoutMs = Number(args[++index]);
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
  const parsed = new URL(options.agentUrl);
  // http on localhost only — a secure context to the browser, so getUserMedia
  // works, which is what makes `next dev` testable before deploying.
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("https required (http allowed on localhost only)");
  }
  agentOrigin = parsed.origin;
  if (parsed.searchParams.get("mode") !== "meeting") {
    // Without it the page answers every utterance in the room — the exact
    // failure mode we replaced ChatGPT to avoid. Refuse rather than join a
    // 商談 with an agent that talks over the client.
    process.stderr.write("--agent-url must include mode=meeting\n");
    process.exit(2);
  }
} catch {
  process.stderr.write(
    `--agent-url must be https, or http on localhost: ${options.agentUrl}\n`,
  );
  process.exit(2);
}

/** Tabs on the agent's origin. The meeting tab lives on meet.google.com and is never touched. */
function agentPages(browser) {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().startsWith(agentOrigin));
}

const browser = await connectToChromeOverCDP(options.cdp);

try {
  if (options.replaceTab) {
    for (const page of agentPages(browser)) {
      await page.close().catch(() => {});
    }
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error("The dedicated Chrome has no browser context.");

  const existing = agentPages(browser)[0];
  const page = existing ?? (await context.newPage());
  await page.goto(options.agentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Gastrobrain redirects an unauthenticated visitor to /login. That needs a
  // human with a Slack account, so say so plainly instead of timing out.
  if (new URL(page.url()).pathname.startsWith("/login")) {
    process.stderr.write("Not signed in to Gastrobrain in the dedicated Chrome.\n");
    process.exit(EXIT_NEEDS_LOGIN);
  }

  // The page connects to the Realtime API on load and publishes its state here.
  // "listening" is the goal: connected, and silent until it hears its name.
  const deadline = Date.now() + options.timeoutMs;
  let state = "";
  while (Date.now() < deadline) {
    state = await page.evaluate(() => document.documentElement.dataset.meetingStatus || "");
    if (state === "listening" || state === "answering") break;
    if (state === "error") {
      const detail = await page
        .evaluate(() => document.querySelector("[data-meeting-error]")?.textContent?.trim() || "")
        .catch(() => "");
      throw new Error(`The agent failed to start${detail ? `: ${detail}` : "."}`);
    }
    await page.waitForTimeout(500);
  }

  if (state !== "listening" && state !== "answering") {
    throw new Error(
      `The agent did not go live within ${options.timeoutMs}ms (last state: ${state || "none"}).`,
    );
  }

  process.stdout.write(`Gastrobrain is live and listening for its name (${state}).\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // Detach from CDP without closing the browser — the meeting is running in it.
  await browser.close().catch(() => {});
}
