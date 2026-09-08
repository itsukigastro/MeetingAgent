#!/usr/bin/env node

/**
 * The chat bridge, end to end, across two tabs in a real Chrome.
 *
 * This is the one test that exercises the whole control path: a message typed
 * in the meeting tab reaches `window.meetingControl.command()` in the agent tab.
 * The collector has its own test and the command parsing is tested in
 * `../gastro/web/src/lib/meeting-mode.test.ts`; what only this can prove is that
 * the two tabs are found, the message crosses between them, and it crosses
 * exactly once.
 *
 * The agent page here is a stub — the real one is a Next.js app. What matters is
 * the shape of the contract, not the behaviour behind it.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { connectToChromeOverCDP } from "../scripts/playwright-cdp.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-chat-bridge-"));
const agentOrigin = "https://gastron-brain-web.vercel.app";
const agentUrl = `${agentOrigin}/voice?mode=meeting`;

const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const allocated = server.address().port;
    server.close(() => resolvePort(allocated));
  });
});

const chrome = spawn(
  executablePath,
  [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const runBridge = () =>
  execFileAsync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/meet-chat-bridge.mjs"),
      "--cdp",
      `http://127.0.0.1:${port}`,
      "--agent-url",
      agentUrl,
      "--once",
    ],
    { cwd: repoRoot, timeout: 30_000 },
  );

let browser;
try {
  let endpointReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    endpointReady = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (endpointReady) break;
    await new Promise((delay) => setTimeout(delay, 100));
  }
  if (!endpointReady) throw new Error("Chrome CDP endpoint did not start.");

  browser = await connectToChromeOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  await context.route("https://meet.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Meet</title>
        <div role="region" aria-label="チャット" id="chat">
          <div><div>田中</div><div>午後1:23</div><div>おつかれさまです</div></div>
        </div>`,
    }),
  );

  // Records what the bridge hands it, and answers with the same vocabulary the
  // real `meetingControl.command()` uses.
  await context.route(`${agentOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Agent</title><script>
        globalThis.__commands = [];
        globalThis.meetingControl = {
          state: () => "asleep",
          set: () => {},
          ask: () => {},
          command: (text) => {
            globalThis.__commands.push(text);
            return text.startsWith("商談AI") ? "ask" : "ignored";
          },
        };
      </script>`,
    }),
  );

  const meetPage = await context.newPage();
  await meetPage.goto("https://meet.google.com/abc-defg-hij");
  const agentPage = await context.newPage();
  await agentPage.goto(agentUrl);

  // First run installs the collector and primes it. The message already on
  // screen is history, and must not be replayed as a command.
  const primed = await runBridge();
  assert.match(primed.stdout, /collector installed/, "the first run installs the collector");
  assert.deepEqual(
    await agentPage.evaluate(() => globalThis.__commands),
    [],
    "chat present before the bridge started must not be delivered",
  );

  // Somebody types at the agent.
  await meetPage.evaluate(() => {
    const block = document.createElement("div");
    block.innerHTML = "<div>Son</div><div>午後1:24</div><div>商談AI 楽天のSKU上限は？</div>";
    document.querySelector("#chat").append(block);
  });

  const delivered = await runBridge();
  assert.match(
    delivered.stdout,
    /already-installed/,
    "a second run must not start a second polling loop",
  );
  assert.deepEqual(
    await agentPage.evaluate(() => globalThis.__commands),
    ["商談AI 楽天のSKU上限は？"],
    "the new message reaches the agent tab",
  );
  assert.match(delivered.stdout, /→ ask/, "the outcome from the page is logged");

  // Draining is destructive: the same message must not arrive twice, or a
  // command would re-fire on every poll for the rest of the meeting.
  await runBridge();
  assert.deepEqual(
    await agentPage.evaluate(() => globalThis.__commands),
    ["商談AI 楽天のSKU上限は？"],
    "a delivered message is not delivered again",
  );

  // A meeting tab with no agent tab is a real state — the agent can crash, or
  // never have been opened. It must fail loudly rather than sit silent.
  await agentPage.close();
  const orphaned = await runBridge().then(
    () => null,
    (error) => error,
  );
  assert.ok(orphaned, "the bridge must exit non-zero with no agent tab");
  assert.match(orphaned.stderr, /No agent tab is open/);
} finally {
  await browser?.close().catch(() => {});
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true });
}

process.stdout.write("Meet chat bridge carries messages to the agent tab, exactly once.\n");
