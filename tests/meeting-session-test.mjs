#!/usr/bin/env node

/**
 * The session supervisor, end to end, in a real Chrome against a stub API.
 *
 * Replaces `meet-chat-bridge-test.mjs`: the bridge is now one loop inside this
 * script, so the chat assertions it made live here too. What only this test can
 * prove is the part that was missing entirely — that a meeting gets registered,
 * that captions reach the API as segments, that the call actually ends when
 * Meet says it ended, and that the end is posted *after* the last segment,
 * because `POST /end` starts summary generation from whatever is in the table.
 *
 * Both halves are stubs (a fake Meet page, a fake FastAPI). What matters is the
 * shape of the two contracts and the order of the calls, not the behaviour
 * behind them.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { getGoogleMeetStatus, countGoogleMeetParticipants } from "../src/providers/google-meet/google-meet-provider.mjs";
import { locatorIsVisible } from "../src/browser/meeting-browser.mjs";
import { connectToChromeOverCDP } from "../scripts/playwright-cdp.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-session-"));
const runtimeDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-runtime-"));
const agentOrigin = "https://gastron-brain-web.vercel.app";
const agentUrl = `${agentOrigin}/voice?mode=meeting`;
const meetUrl = "https://meet.google.com/abc-defg-hij";
const meetingId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const TOKEN = "test-meeting-agent-token";

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// --------------------------------------------------------------------------
// The stub Gastrobrain API — records every call, in order
// --------------------------------------------------------------------------

const received = [];
let agentStateRow = "asleep";
let failSegments = false;
let failEnd = false;
let loseFirstSegmentResponse = true;
const inserted = new Map();

const api = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const entry = {
      method: request.method,
      path: request.url,
      token: request.headers["x-meeting-agent-token"],
      body: body ? JSON.parse(body) : undefined,
    };
    received.push(entry);

    const reply = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (entry.token !== TOKEN) return reply(401, { detail: "invalid meeting agent token" });
    if (request.method === "POST" && request.url === "/v1/meetings") {
      return reply(200, { id: meetingId, status: "scheduled", agent_state: "asleep" });
    }
    if (request.method === "GET" && request.url.endsWith("/state")) {
      return reply(200, { agent_state: agentStateRow });
    }
    if (request.method === "POST" && request.url.endsWith("/segments")) {
      if (failSegments) return reply(503, { detail: "offline" });
      for (const segment of entry.body.segments) inserted.set(`${entry.path}:${segment.seq}`, segment);
      if (loseFirstSegmentResponse) {
        loseFirstSegmentResponse = false;
        return reply(503, { detail: "response lost after commit" });
      }
      return reply(200, { inserted: entry.body.segments.length });
    }
    if (request.method === "POST" && request.url.endsWith("/end")) {
      if (failEnd) return reply(503, { detail: "end unavailable" });
      return reply(202, { status: "ended" });
    }
    if (request.method === "PATCH") {
      if (entry.body.agent_state) agentStateRow = entry.body.agent_state;
      return reply(200, { id: meetingId });
    }
    return reply(404, { detail: "not found" });
  });
});

const apiPort = await freePort();
await new Promise((listening) => api.listen(apiPort, "127.0.0.1", listening));

// --------------------------------------------------------------------------
// Chrome
// --------------------------------------------------------------------------

const cdpPort = await freePort();
const chrome = spawn(
  executablePath,
  [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sessionEnv = {
  ...process.env,
  MEETING_COPILOT_RUNTIME_DIR: runtimeDir,
  GASTROBRAIN_API_URL: `http://127.0.0.1:${apiPort}`,
  MEETING_AGENT_TOKEN: TOKEN,
  MEETING_COPILOT_OPERATOR_EMAIL: "itsuki.son@gastroduce-japan.co.jp",
};

const sessionArgs = (extra) => [
  resolve(repoRoot, "scripts/meeting-session.mjs"),
  "--meet-url",
  meetUrl,
  "--agent-url",
  agentUrl,
  "--cdp",
  `http://127.0.0.1:${cdpPort}`,
  ...extra,
];

/** A live Meet: a leave button, two participants, chat and captions. */
const meetBody = `<!doctype html><title>Meet - 週次定例</title>
  <button aria-label="通話から退出">leave</button>
  <div data-participant-id="p1"></div><div data-participant-id="p2"></div>
  <div role="region" aria-label="チャット" id="chat">
    <div><div>田中</div><div>午後1:23</div><div>おつかれさまです</div></div>
  </div>
  <div role="region" aria-label="字幕" id="captions"></div>`;

let browser;
let session;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ready = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    await wait(100);
  }
  if (!ready) throw new Error("Chrome CDP endpoint did not start.");

  browser = await connectToChromeOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];

  await context.route("https://meet.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: meetBody }),
  );

  // The agent page, reduced to the contract it publishes: the state attributes
  // and `window.meetingControl`.
  await context.route(`${agentOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Agent</title><script>
        globalThis.__commands = [];
        const params = new URLSearchParams(location.search);
        const root = document.documentElement;
        root.dataset.meetingStatus = "listening";
        root.dataset.meetingAgentState = "asleep";
        if (params.get("meeting_id")) root.dataset.meetingId = params.get("meeting_id");
        globalThis.meetingControl = {
          state: () => root.dataset.meetingAgentState,
          set: (next) => { root.dataset.meetingAgentState = next; },
          ask: () => {},
          command: (text) => {
            globalThis.__commands.push(text);
            if (text.startsWith("商談AI")) {
              root.dataset.meetingAgentState = "open";
              return "ask";
            }
            return "ignored";
          },
        };
      </script>`,
    }),
  );

  // Unrelated tabs deliberately precede the target: neither can be driven or closed.
  const unrelatedMeet = await context.newPage();
  await unrelatedMeet.goto("https://meet.google.com/zzz-yyyy-xxx");
  const dashboard = await context.newPage();
  await dashboard.goto(`${agentOrigin}/meetings`);
  const meetPage = await context.newPage();
  await meetPage.goto(meetUrl);
  assert.equal(await countGoogleMeetParticipants(meetPage), null, "rendered tiles are not an attendance total");
  await meetPage.evaluate(() => {
    const modal = document.createElement("div");
    modal.id = "settings";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
  });
  assert.equal((await getGoogleMeetStatus(browser, locatorIsVisible, meetPage)).connection, "joined", "modal must not hide live-call detection");
  await meetPage.evaluate(() => document.querySelector("#settings").remove());
  const agentPage = await context.newPage();
  await agentPage.goto(agentUrl);

  // ---- 1. --once is a diagnostic: it primes, reports, and writes nothing ----
  const primed = await execFileAsync(process.execPath, sessionArgs(["--once"]), {
    cwd: repoRoot,
    env: sessionEnv,
    timeout: 30_000,
  });
  assert.match(primed.stdout, /\((?:installed|already-installed)\)/, "the collectors are installed");
  assert.deepEqual(
    await agentPage.evaluate(() => globalThis.__commands),
    [],
    "chat already on screen when the session starts is history, not a command",
  );
  assert.equal(received.length, 0, "--once must never create a meeting");

  // ---- 2. the real thing ---------------------------------------------------
  session = spawn(process.execPath, sessionArgs(["--poll", "250", "--segments", "250"]), {
    cwd: repoRoot,
    env: sessionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  session.stdout.on("data", (chunk) => {
    out += chunk;
  });
  session.stderr.on("data", (chunk) => {
    out += chunk;
  });

  // Wait for it to register the meeting and bind the agent tab, rather than
  // guessing how long a cold Node start plus a CDP connect takes.
  const until = async (what, predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await wait(100);
    }
    throw new Error(`timed out waiting for ${what}:\n${out}`);
  };

  await until("the agent tab to be bound to the meeting", () =>
    context.pages().some((page) => page.url().includes(`meeting_id=${meetingId}`)),
  );
  const boundAgent = context.pages().find((page) => page.url().includes(`meeting_id=${meetingId}`));
  assert.match(
    boundAgent.url(),
    new RegExp(`meeting_id=${meetingId}`),
    `the agent tab is pointed at this meeting, which is what makes its thread a meeting thread:\n${out}`,
  );

  await until("initial API state sync", () => received.some(entry => entry.path.endsWith("/state")));
  await wait(300);

  // Somebody talks, and somebody types at the agent.
  await meetPage.evaluate(() => {
    document.querySelector("#captions").innerHTML =
      "<div><div>田中</div><div>楽天のSKU上限を確認したい</div></div>";
    const block = document.createElement("div");
    block.innerHTML = "<div>Son</div><div>午後1:24</div><div>商談AI 起きて</div>";
    document.querySelector("#chat").append(block);
  });

  // The web UI quiets the agent while it is running: the polled value has to
  // reach the page, and only on change.
  await until("local wake written to API", () => agentStateRow === "open");
  agentStateRow = "asleep";
  await until("web quiet applied", () => boundAgent.evaluate(() => globalThis.meetingControl.state() === "asleep"));
  await wait(700);
  assert.equal(agentStateRow, "asleep", "web quiet must not echo stale local open back");

  // Captions settle after 1.5 s of no edits before they are emitted.
  await wait(2_500);

  // The call ends: Meet swaps the leave button for its post-call screen.
  await meetPage.evaluate(() => {
    document.body.innerHTML = "<div>通話から退出しました</div>";
  });

  await until("supervisor exit", () => session.exitCode !== null);
  const exitCode = session.exitCode;
  assert.equal(exitCode, 0, `the supervisor should exit cleanly:\n${out}`);

  // ---- 3. what the API saw -------------------------------------------------
  const paths = received.map((entry) => `${entry.method} ${entry.path}`);

  const upsert = received.find((entry) => entry.path === "/v1/meetings");
  assert.ok(upsert, `the meeting is registered:\n${paths.join("\n")}`);
  assert.equal(upsert.body.google_event_id.startsWith("meet:abc-defg-hij:"), true);
  assert.deepEqual(upsert.body.attendees, [
    { email: "itsuki.son@gastroduce-japan.co.jp", is_organizer: true },
  ]);
  assert.equal(upsert.body.title, "週次定例", "the Meet tab's own title names the meeting");

  const live = received.find(
    (entry) => entry.method === "PATCH" && entry.body?.status === "live",
  );
  assert.ok(live, "the meeting is marked live while it runs");
  assert.ok(live.body.started_at, "with the time the AI actually joined");

  const segments = received.filter((entry) => entry.path.endsWith("/segments"));
  assert.ok(segments.length > 0, `captions reach the API:\n${out}`);
  assert.ok(segments.length >= 2, "ambiguous successful insert is retried");
  assert.deepEqual(segments[0].body, segments[1].body, "retry retains the same seq");
  const lines = [...inserted.values()];
  assert.deepEqual(
    lines.map((line) => [line.seq, line.speaker, line.text]),
    [[1, "田中", "楽天のSKU上限を確認したい"]],
    "speaker-labelled, sequenced, and sent exactly once",
  );

  const end = received.findIndex((entry) => entry.path.endsWith("/end"));
  assert.ok(end >= 0, "the meeting is ended, which is what generates the summary");
  const lastSegment = received.map((e) => e.path.endsWith("/segments")).lastIndexOf(true);
  assert.ok(
    lastSegment < end,
    "every segment is posted before the end — the summary is generated from what is in the table at that moment",
  );

  // ---- 4. the call is actually closed --------------------------------------
  assert.equal(
    context.pages().some((page) => page.url() === meetUrl),
    false,
    "the AI left the call and the Meet tab was closed",
  );
  assert.equal(
    context.pages().some((page) => page.url().includes(`meeting_id=${meetingId}`)),
    false,
    "and the agent tab went with it, so the Realtime session stops billing",
  );

  assert.equal(unrelatedMeet.isClosed(), false, "unrelated Meet tab survives");
  assert.equal(dashboard.isClosed(), false, "dashboard survives");
  const saved = JSON.parse(await readFile(resolve(runtimeDir, "meeting-session.json"), "utf8"));
  assert.ok(saved.endedAt);
  assert.deepEqual(saved.pending, []);

  // ---- 5. the chat path still works ----------------------------------------
  assert.match(out, /商談AI 起きて → ask/, "a typed command reaches the agent and is logged");
  assert.match(out, /\[state\] agent is open/, "and the state it caused is written back");

  // ---- 6. Offline teardown survives process exit and recovers without Chrome.
  failSegments = true;
  failEnd = true;
  const meet2 = await context.newPage();
  await meet2.goto(meetUrl);
  const agent2 = await context.newPage();
  await agent2.goto(agentUrl);
  const previousCount = received.length;
  session = spawn(process.execPath, sessionArgs(["--poll", "250", "--segments", "250"]), {
    cwd: repoRoot, env: sessionEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  session.stdout.on("data", chunk => { out += chunk; });
  session.stderr.on("data", chunk => { out += chunk; });
  await until("second session initial state", () => received.slice(previousCount).some(e => e.path.endsWith("/state")));
  await meet2.evaluate(() => {
    document.querySelector("#captions").innerHTML = "<div><div>佐藤</div><div>失敗しても保存する</div></div>";
  });
  const readSaved = async () => JSON.parse(await readFile(resolve(runtimeDir, "meeting-session.json"), "utf8"));
  await until("durable caption outbox", async () => (await readSaved()).pending?.length === 1);
  session.kill("SIGTERM");
  await until("offline teardown exit", () => session.exitCode !== null);
  assert.equal(session.exitCode, 1, out);
  let recovery = await readSaved();
  assert.equal(recovery.endedAt, null, "failed upload must not mark the record finished");
  assert.ok(recovery.endRequestedAt);
  assert.equal(recovery.pending.length, 1, "failed batch survives process exit");
  assert.equal(meet2.isClosed(), true, "API outage never prevents leaving");
  assert.equal(agent2.isClosed(), true, "or stopping voice");

  failSegments = false;
  const recoverArgs = [resolve(repoRoot, "scripts/meeting-session.mjs"), "--recover-only"];
  await assert.rejects(execFileAsync(process.execPath, recoverArgs, { cwd: repoRoot, env: sessionEnv, timeout: 20_000 }));
  recovery = await readSaved();
  assert.deepEqual(recovery.pending, [], "recovery uploaded pending captions");
  assert.equal(recovery.endedAt, null, "failed /end is still pending");
  const endedAt = recovery.endRequestedAt;
  failEnd = false;
  await execFileAsync(process.execPath, recoverArgs, { cwd: repoRoot, env: sessionEnv, timeout: 20_000 });
  recovery = await readSaved();
  assert.equal(recovery.endedAt, endedAt, "retry preserves actual call end time");
  assert.ok(received.at(-1).path.endsWith("/end"));
  assert.equal(unrelatedMeet.isClosed(), false, "recovery requires no browser changes");

} finally {
  session?.kill("SIGKILL");
  await browser?.close().catch(() => {});
  chrome.kill();
  await new Promise((closed) => api.close(closed));
  await rm(profileDir, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
}

process.stdout.write("Meeting session registers, streams, ends the call, and posts the summary.\n");
