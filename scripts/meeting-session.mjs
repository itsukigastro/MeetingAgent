#!/usr/bin/env node

/** Owns one admitted Meet call: recording, chat, state sync and teardown.
 * Node alone holds the service credential; browser automation ports to Linux.
 * Run-state is a durable outbox. A failed final flush or /end is recoverable
 * with --recover-only, and never silently reported as a completed recording.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectToChromeOverCDP } from "./playwright-cdp.mjs";
import { locatorIsVisible } from "../src/browser/meeting-browser.mjs";
import {
  countGoogleMeetParticipants,
  getGoogleMeetStatus,
  leaveGoogleMeet,
  normalizeGoogleMeetUrl,
} from "../src/providers/google-meet/google-meet-provider.mjs";
import {
  drainMeetCaptions,
  enableCaptions,
  installCaptionCollector,
} from "../src/providers/google-meet/meet-captions.mjs";
import {
  drainMeetChat,
  installChatCollector,
  openChatPanel,
} from "../src/providers/google-meet/meet-chat.mjs";
import { createMeetingClient } from "../src/meeting/gastrobrain-client.mjs";
import { createEndWatcher } from "../src/meeting/end-detection.mjs";
import { meetingEventId, titleFromMeetPageTitle } from "../src/meeting/meeting-identity.mjs";
import { openRunStore } from "../src/meeting/run-state.mjs";
import { createStateSync } from "../src/meeting/state-sync.mjs";
import { createSegmentQueue } from "../src/meeting/segment-queue.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_AGENT_URL = "https://gastron-brain-web.vercel.app/voice?mode=meeting";
const COMPANY_DOMAIN = "@gastroduce-japan.co.jp";

/** How often everything is checked. The contract's polling interval (§6.3). */
const DEFAULT_POLL_MS = 3_000;
/** Captions are batched to this, not posted per line. */
const DEFAULT_SEGMENT_MS = 5_000;
/** Silence this long with the collector installed means the selectors moved. */
const CAPTION_SILENCE_WARN_MS = 60_000;
/** A dead agent tab is reloaded, but never in a tight loop. */
const AGENT_RELOAD_COOLDOWN_MS = 60_000;

const log = (tag, message) =>
  process.stdout.write(`${new Date().toISOString()} [${tag}] ${message}\n`);
const warn = (tag, message) =>
  process.stderr.write(`${new Date().toISOString()} [${tag}] ${message}\n`);

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

/**
 * `.meeting-copilot.env` holds the per-machine values the installer generated
 * (the CDP port) and the secrets an operator added by hand. A real environment
 * variable wins over the file, the way every shell script here resolves them.
 */
function readEnvFile() {
  const values = {};
  try {
    const file = readFileSync(resolve(repoRoot, ".meeting-copilot.env"), "utf8");
    for (const line of file.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=['"]?(.*?)['"]?\s*$/);
      if (match) values[match[1]] = match[2];
    }
  } catch {
    // A fresh checkout that has not run the setup script yet.
  }
  return values;
}

const fileEnv = readEnvFile();
const fromEnv = (name, fallback = "") =>
  (process.env[name] ?? fileEnv[name] ?? fallback).trim();

const options = {
  meetUrl: "",
  agentUrl: fromEnv("MEETING_COPILOT_AGENT_URL", DEFAULT_AGENT_URL),
  cdp: `http://127.0.0.1:${fromEnv("MEETING_COPILOT_CDP_PORT", "9223")}`,
  operator: fromEnv("MEETING_COPILOT_OPERATOR_EMAIL"),
  attendees: [],
  eventId: "",
  title: "",
  pollMs: DEFAULT_POLL_MS,
  segmentMs: DEFAULT_SEGMENT_MS,
  noApi: false,
  once: false,
  recoverOnly: false,
};

function usage() {
  process.stdout.write(
    `Usage: node scripts/meeting-session.mjs --meet-url URL [options]\n\n` +
      `Runs for the length of one meeting: streams the transcript to Gastrobrain,\n` +
      `carries Meet chat to the agent, and ends the session when the call ends.\n\n` +
      `Options:\n` +
      `  --meet-url URL     the meeting this session belongs to (required)\n` +
      `  --agent-url URL    agent tab to drive (default: ${DEFAULT_AGENT_URL})\n` +
      `  --operator EMAIL   who may read this meeting; also the Gastrobrain login\n` +
      `  --attendee EMAIL   another participant who may read it (repeatable)\n` +
      `  --event-id ID      Google Calendar event id, when there is one\n` +
      `  --title TEXT       meeting title (default: the Meet tab's own title)\n` +
      `  --cdp URL          Chrome DevTools endpoint (default: ${options.cdp})\n` +
      `  --poll MS          tick interval (default: ${DEFAULT_POLL_MS})\n` +
      `  --segments MS      caption batch interval (default: ${DEFAULT_SEGMENT_MS})\n` +
      `  --no-api           chat and end-detection only; write nothing to Gastrobrain\n` +
      `  --recover-only    retry saved captions and /end without touching Chrome\n` +
      `  --once             drain chat and captions once, print, exit. Diagnostics.\n` +
      `  -h, --help         show this help\n\n` +
      `Environment (or .meeting-copilot.env):\n` +
      `  GASTROBRAIN_API_URL, MEETING_AGENT_TOKEN, MEETING_COPILOT_OPERATOR_EMAIL,\n` +
      `  MEETING_COPILOT_AGENT_URL, MEETING_COPILOT_CDP_PORT\n\n` +
      `Ctrl-C ends the meeting session: the AI leaves the call and the summary is\n` +
      `generated. It is not a way to detach from a meeting and leave it running.\n`,
  );
}

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const next = () => args[++index] || "";
  switch (args[index]) {
    case "--meet-url": options.meetUrl = next(); break;
    case "--agent-url": options.agentUrl = next(); break;
    case "--operator": options.operator = next(); break;
    case "--attendee": options.attendees.push(next()); break;
    case "--event-id": options.eventId = next(); break;
    case "--title": options.title = next(); break;
    case "--cdp": options.cdp = next(); break;
    case "--poll": options.pollMs = Number(next()); break;
    case "--segments": options.segmentMs = Number(next()); break;
    case "--no-api": options.noApi = true; break;
    case "--recover-only": options.recoverOnly = true; break;
    case "--once": options.once = true; break;
    case "-h":
    case "--help": usage(); process.exit(0); break;
    default:
      process.stderr.write(`Unknown argument: ${args[index]}\n`);
      usage();
      process.exit(2);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

for (const [name, value] of [["--poll", options.pollMs], ["--segments", options.segmentMs]]) {
  if (!Number.isFinite(value) || value < 100) fail(`${name} must be a number of milliseconds >= 100`);
}

let meeting;
try {
  if (!options.recoverOnly) meeting = normalizeGoogleMeetUrl(options.meetUrl);
} catch (error) {
  fail(`--meet-url must be a Google Meet URL: ${error.message}`);
}

let agentOrigin;
try {
  const url = new URL(options.agentUrl);
  if (url.searchParams.get("mode") !== "meeting" || url.pathname !== "/voice") {
    throw new Error("expected /voice?mode=meeting");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("HTTPS required except on localhost");
  }
  agentOrigin = url.origin;
} catch (error) {
  fail(`Invalid --agent-url: ${error.message}`);
}
options.operator = options.operator.toLowerCase();
options.attendees = options.attendees.map((email) => email.trim().toLowerCase());
if (options.recoverOnly && (options.once || options.noApi)) fail("--recover-only requires API recording");

const apiBaseUrl = fromEnv("GASTROBRAIN_API_URL");
const apiToken = fromEnv("MEETING_AGENT_TOKEN");
// `--once` is a diagnostic: it must never create or end a meeting.
const useApi = !options.noApi && !options.once;

if (useApi) {
  if (!apiBaseUrl || !apiToken) {
    fail(
      "GASTROBRAIN_API_URL and MEETING_AGENT_TOKEN must be set to record a meeting.\n" +
        "Add them to .meeting-copilot.env, or pass --no-api to run without recording.",
    );
  }
  // Fail-closed access control (MEETINGS_WEB.md §5): a meeting posted with no
  // attendees is readable by nobody, and — because the agent's own thread is
  // participant-checked — the agent could not read it either. Better to refuse
  // than to record a meeting into a hole.
  if (!options.recoverOnly && !options.operator) {
    fail(
      "--operator EMAIL (or MEETING_COPILOT_OPERATOR_EMAIL) is required: it is who may\n" +
        "read this meeting, and the Gastrobrain login the agent answers as.",
    );
  }
  if (!options.recoverOnly && !/^[^@\s]+@gastroduce-japan\.co\.jp$/.test(options.operator)) {
    fail(`--operator must be a ${COMPANY_DOMAIN} address: ${options.operator}`);
  }
}

// Persist both the allocation watermark and pending batches BEFORE HTTP. A
// timeout may mean the server committed; replaying the same seq is idempotent.
const runtimeDir = resolve(fromEnv("MEETING_COPILOT_RUNTIME_DIR", resolve(repoRoot, ".meeting-copilot-runtime")));
const client = useApi ? createMeetingClient({ baseUrl: apiBaseUrl, token: apiToken, log: (message) => warn("api", message) }) : null;
let store;
let state = null;
let queue = createSegmentQueue();
let browser;
let meetPage;
let agentPage;
let owned = false;
let stopReason = "";
let apiWork = null;
let inFlight = [];
let agentReloads = 0;
const sync = createStateSync();
const endWatcher = createEndWatcher({
  aloneTicks: Math.ceil(120_000 / options.pollMs),
  unjoinedGraceTicks: Math.ceil(60_000 / options.pollMs),
});
const meetingPageUrl = (id) => `${agentOrigin}/meetings/${id}`;
const persist = () => {
  if (state) {
    const snapshot = queue.snapshot();
    store.write({ ...state, ...snapshot, pending: [...inFlight, ...snapshot.pending] });
  }
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const pages = () => browser.contexts().flatMap((context) => context.pages());
const onMeetingUrl = (page) => {
  try { return normalizeGoogleMeetUrl(page.url()).meetingKey === meeting.meetingKey; }
  catch { return false; }
};
async function safely(what, operation) {
  try { return await operation(); }
  catch (error) { warn(what, error.message); return null; }
}

async function flushSegments() {
  if (!state?.meetingId) return;
  while (queue.size) {
    const batch = queue.take();
    inFlight = batch;
    try {
      await client.postSegments(state.meetingId, batch);
    } catch (error) {
      inFlight = [];
      queue.requeue(batch);
      persist();
      throw error;
    }
    inFlight = [];
    persist();
  }
}

async function finishRecord() {
  if (!state?.meetingId || state.endedAt) return;
  state.endRequestedAt ||= new Date().toISOString();
  persist();
  await flushSegments(); // Never summarize before pending captions are accepted.
  await client.end(state.meetingId, state.endRequestedAt);
  state.endedAt = state.endRequestedAt;
  persist();
  log("end", `summary is generating — ${meetingPageUrl(state.meetingId)}`);
}

process.on("SIGINT", () => { stopReason ||= "interrupted (SIGINT)"; });
process.on("SIGTERM", () => { stopReason ||= "terminated (SIGTERM)"; });

try {
  store = openRunStore(runtimeDir);
  if (useApi) {
    state = store.read();
    if (state) queue = createSegmentQueue({ startSeq: state.seq, pending: state.pending });
  }
  if (options.recoverOnly) {
    await finishRecord();
    log("session", "recovery complete");
  } else {
    browser = await connectToChromeOverCDP(options.cdp);
    browser.on("disconnected", () => { stopReason ||= "Chrome disconnected"; });
    meetPage = pages().find(onMeetingUrl);
    if (!meetPage) throw new Error("No tab matches --meet-url in the dedicated Chrome.");
    const agents = pages().filter((page) => {
      try {
        const url = new URL(page.url());
        return url.origin === agentOrigin && url.pathname === "/voice" && url.searchParams.get("mode") === "meeting";
      } catch { return false; }
    });
    if (agents.length !== 1) throw new Error("Expected exactly one /voice?mode=meeting tab. Open the agent or close duplicate agent tabs.");
    agentPage = agents[0];
    meetPage.on("crash", () => { stopReason ||= "Meet tab crashed"; });
    meetPage.on("close", () => { stopReason ||= "Meet tab closed"; });
    agentPage.on("close", () => { stopReason ||= "agent tab closed"; });
    agentPage.on("crash", () => { stopReason ||= "agent tab crashed"; });

    // Do not claim 'live', consume captions, or start the alone timer in prejoin.
    while (!stopReason) {
      const status = await getGoogleMeetStatus(browser, locatorIsVisible, meetPage);
      if (status.connection === "joined") break;
      if (["ended", "rejected"].includes(status.connection)) throw new Error(`Cannot supervise: Meet is ${status.connection}`);
      if (options.once) throw new Error("--once requires an admitted meeting");
      log("session", "waiting for Meet admission");
      await pause(options.pollMs);
    }
    if (stopReason) throw new Error(stopReason);
    endWatcher.observe({ connection: "joined", onMeetingUrl: true, participants: null });

    if (useApi) {
      const requestedEvent = options.eventId || meetingEventId(meeting.url);
      const resume = state?.meetingId && !state.endedAt && !state.endRequestedAt &&
        state.meetUrl === meeting.displayUrl && (!options.eventId || state.googleEventId === options.eventId);
      if (state && !state.endedAt && !resume) await finishRecord();
      if (!resume) {
        // Reusing an already-ended ad-hoc link the same day is a NEW call.
        let googleEventId = state && !state.meetingId && state.meetUrl === meeting.displayUrl
          ? state.googleEventId : requestedEvent;
        if (state?.endedAt && state.meetUrl === meeting.displayUrl && !options.eventId) {
          googleEventId += `:${Date.now()}`;
        }
        queue = createSegmentQueue();
        state = { googleEventId, meetUrl: meeting.displayUrl, startedAt: new Date().toISOString(), endedAt: null };
        persist();
        const created = await client.upsert({
          googleEventId,
          title: options.title || titleFromMeetPageTitle(await meetPage.title(), meeting.url),
          meetUrl: meeting.displayUrl,
          scheduledAt: state.startedAt,
          attendees: [...new Set([options.operator, ...options.attendees])].map((email) => ({ email, isOrganizer: email === options.operator })),
        });
        if (!created.id || ["ended", "failed"].includes(created.status)) throw new Error("API returned an ended/invalid meeting; use a distinct --event-id for a new call");
        state.meetingId = created.id;
        persist();
      } else {
        log("session", `resuming meeting ${state.meetingId} from seq ${queue.seq}`);
      }
      log("session", meetingPageUrl(state.meetingId));
      owned = !options.once;
      const wanted = new URL(options.agentUrl);
      wanted.searchParams.set("meeting_id", state.meetingId);
      if (new URL(agentPage.url()).searchParams.get("meeting_id") !== state.meetingId) {
        await agentPage.goto(wanted.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
      }
    }

    async function installCollectors() {
      await safely("chat panel", () => openChatPanel(meetPage, locatorIsVisible));
      const chat = await installChatCollector(meetPage);
      await safely("captions", () => enableCaptions(meetPage, locatorIsVisible));
      const captions = await installCaptionCollector(meetPage);
      log("session", `collectors (${chat}), captions (${captions})`);
    }
    owned = !options.once;
    await installCollectors();
    let lastFlush = 0;
    let liveWritten = false;
    let lastCaptionAt = Date.now();
    let captionWarned = false;
    let lastAgentReload = 0;
    let unhealthySince = null;
    let lastDropped = queue.dropped;
    let bindingWarned = false;
    const boundStartedAt = Date.now();

    // Network work has one in-flight worker. A slow API never blocks Meet chat,
    // end detection, or caption draining. Teardown joins it before final flush.
    async function syncApi() {
      if (!liveWritten) {
        await client.patch(state.meetingId, { status: "live", startedAt: state.startedAt });
        liveWritten = true;
      }
      if (Date.now() - lastFlush >= options.segmentMs) {
        lastFlush = Date.now();
        await flushSegments();
      }
      const remote = await client.getState(state.meetingId);
      const local = await agentPage.evaluate(() => globalThis.meetingControl?.state());
      await sync.sync({
        remote: remote.agent_state, local,
        apply: (next) => agentPage.evaluate((value) => {
          const control = globalThis.meetingControl;
          if (!control || !["listening", "answering"].includes(document.documentElement.dataset.meetingStatus)) return false;
          control.set(value, "web");
          return control.state() === value;
        }, next),
        push: async (next) => {
          await client.patch(state.meetingId, { agentState: next });
          log("state", `agent is ${next}`);
          return true;
        },
      });
    }

    if (useApi) await safely("initial sync", syncApi);

    do {
      const chat = await drainMeetChat(meetPage).catch(() => ({ installed: false, messages: [] }));
      for (const message of chat.messages) {
        const outcome = await agentPage.evaluate((text) => globalThis.meetingControl?.command(text) ?? "no-control", message.text).catch(() => "unreachable");
        log("chat", `${message.sender || "?"}: ${message.text} → ${outcome}`);
      }
      const captions = await drainMeetCaptions(meetPage).catch(() => ({ installed: false, entries: [] }));
      const added = queue.push(captions.entries);
      if (added) {
        persist();
        lastCaptionAt = Date.now();
        captionWarned = false;
        log("captions", `${added} captured, ${queue.accepted} total`);
      }
      if (queue.dropped > lastDropped) {
        warn("captions", `${queue.dropped - lastDropped} oldest captions dropped: queue limit`);
        lastDropped = queue.dropped;
      }
      if (!captionWarned && Date.now() - lastCaptionAt >= CAPTION_SILENCE_WARN_MS) {
        captionWarned = true;
        warn("captions", `no captions for 60s (region ${captions.region || "none"}); check CAPTION_REGION_SELECTORS`);
      }
      if (options.once) {
        log("session", `drained once: ${chat.messages.length} chat, ${queue.size} caption(s)`);
        break;
      }
      if (!stopReason && (!chat.installed || !captions.installed)) await safely("collectors", installCollectors);

      const status = await getGoogleMeetStatus(browser, locatorIsVisible, meetPage).catch(() => ({ connection: "unknown" }));
      const verdict = endWatcher.observe({
        tabClosed: meetPage.isClosed(), connection: status.connection,
        onMeetingUrl: onMeetingUrl(meetPage), participants: await countGoogleMeetParticipants(meetPage),
      });
      if (verdict.ended) stopReason ||= verdict.reason;
      const agentStatus = await agentPage.evaluate(() => document.documentElement.dataset.meetingStatus || "").catch(() => "error");
      if (state?.meetingId && !bindingWarned && Date.now() - boundStartedAt >= 60_000) {
        const bound = await agentPage.evaluate(() => document.documentElement.dataset.meetingId).catch(() => null);
        if (bound !== state.meetingId) {
          bindingWarned = true;
          warn("agent", "meeting thread is not bound; check operator email, participant access, and deployed web version");
        }
      }
      if (["listening", "answering"].includes(agentStatus)) unhealthySince = null;
      else unhealthySince ??= Date.now();
      if (unhealthySince && Date.now() - unhealthySince >= 180_000) stopReason ||= "agent did not recover within 180s";
      if (!stopReason && ["ended", "error"].includes(agentStatus) && Date.now() - lastAgentReload >= AGENT_RELOAD_COOLDOWN_MS) {
        lastAgentReload = Date.now();
        agentReloads += 1;
        log("session", `agent is ${agentStatus}; reload ${agentReloads}`);
        await safely("reload", () => agentPage.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }));
      }
      if (useApi && !apiWork && !stopReason) {
        apiWork = safely("api", syncApi).finally(() => { apiWork = null; });
      }
      if (!stopReason) await pause(options.pollMs);
    } while (!stopReason);
  }
} catch (error) {
  warn("session", error.message);
  stopReason ||= "supervisor error";
  process.exitCode = 1;
} finally {
  if (owned) {
    log("end", stopReason || "stopping");
    if (state?.meetingId) state.endRequestedAt ||= new Date().toISOString();
    // Silence first, before any slow API work; a closed tab also stops WebRTC.
    await safely("close agent", () => agentPage.close({ runBeforeUnload: false }));
    const tail = await safely("caption tail", () => drainMeetCaptions(meetPage, { final: true }));
    queue.push(tail?.entries);
    await safely("persist", async () => persist());
    await safely("leave", () => leaveGoogleMeet(browser, locatorIsVisible, meetPage));
    if (process.platform === "darwin") {
      await safely("audio restore", async () => {
        const { restoreAudio } = await import("./audio-backend.mjs");
        await restoreAudio();
      });
    }
    await apiWork;
    if (state?.meetingId) {
      const result = await safely("finalize", async () => { await finishRecord(); return true; });
      if (!result) {
        process.exitCode = 1;
        warn("end", "captions/end saved for retry: node scripts/meeting-session.mjs --recover-only");
      }
    }
    log("session", `done — ${queue.accepted} captions, ${queue.dropped} dropped, ${agentReloads} reload(s)`);
  }
  await browser?.close().catch(() => {}); // CDP detach; never closes unrelated tabs.
  store?.close();
}
