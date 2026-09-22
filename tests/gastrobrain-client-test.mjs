#!/usr/bin/env node

/**
 * The client is where a shared write-access token meets an unreliable network,
 * so the things worth pinning are: the exact contract shape (§6.2), retrying
 * only what is worth retrying, and never leaking the token into a log line or
 * an exception — this process writes its output to a terminal and a log file
 * an operator will paste into Slack.
 */

import assert from "node:assert/strict";
import { createMeetingClient, MeetingApiError } from "../src/meeting/gastrobrain-client.mjs";

const TOKEN = "super-secret-token";
const base = "https://api.example.com";

/** A fetch that answers from a script of responses and records every call. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      const next = queue.shift();
      if (typeof next === "function") return next();
      const { status = 200, body = {} } = next ?? {};
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    },
  };
}

const noSleep = async () => {};

// --- the contract shape ----------------------------------------------------
{
  const f = fakeFetch([{ body: { id: "m-1", status: "scheduled", agent_state: "asleep" } }]);
  const client = createMeetingClient({ baseUrl: base, token: TOKEN, fetchImpl: f.fetch });
  const created = await client.upsert({
    googleEventId: "meet:abc-defg-hij:2026-09-21",
    title: "週次定例",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-09-21T01:00:00.000Z",
    attendees: [{ email: "itsuki.son@gastroduce-japan.co.jp", isOrganizer: true }],
  });
  assert.equal(created.id, "m-1");

  const [call] = f.calls;
  assert.equal(call.url, "https://api.example.com/v1/meetings");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-Meeting-Agent-Token"], TOKEN);
  assert.deepEqual(call.body, {
    google_event_id: "meet:abc-defg-hij:2026-09-21",
    title: "週次定例",
    meet_url: "https://meet.google.com/abc-defg-hij",
    scheduled_at: "2026-09-21T01:00:00.000Z",
    // snake_case, and is_organizer spelled out: this is the ACL, and a field
    // the server does not recognise means a meeting nobody can read.
    attendees: [{ email: "itsuki.son@gastroduce-japan.co.jp", is_organizer: true }],
  });
}

{
  // PATCH carries only what was asked for. Sending `title: undefined` would be
  // dropped by JSON, but sending `title: null` is a 403 for the agent.
  const f = fakeFetch([{ body: {} }]);
  const client = createMeetingClient({ baseUrl: base, token: TOKEN, fetchImpl: f.fetch });
  await client.patch("m-1", { agentState: "open" });
  assert.deepEqual(f.calls[0].body, { agent_state: "open" });
  assert.equal(f.calls[0].init.method, "PATCH");
}

{
  const f = fakeFetch([{ body: { agent_state: "open" } }]);
  const client = createMeetingClient({ baseUrl: base, token: TOKEN, fetchImpl: f.fetch });
  assert.deepEqual(await client.getState("m-1"), { agent_state: "open" });
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.body, undefined, "a GET must not carry a body");
}

// --- retries ---------------------------------------------------------------
{
  const f = fakeFetch([
    { status: 503, body: "upstream restarting" },
    () => {
      throw new Error("ECONNRESET");
    },
    { body: { inserted: 2 } },
  ]);
  const client = createMeetingClient({
    baseUrl: base,
    token: TOKEN,
    fetchImpl: f.fetch,
    sleep: noSleep,
  });
  const result = await client.postSegments("m-1", [{ seq: 1, speaker: "田中", text: "はい" }]);
  assert.deepEqual(result, { inserted: 2 });
  assert.equal(f.calls.length, 3, "a 503 and a dropped connection are both worth retrying");
}

{
  // A 404 is the same answer however many times it is asked, and during a
  // meeting every wasted retry is latency on the next caption batch.
  const f = fakeFetch([{ status: 404, body: '{"detail":"meeting not found"}' }]);
  const client = createMeetingClient({
    baseUrl: base,
    token: TOKEN,
    fetchImpl: f.fetch,
    sleep: noSleep,
  });
  const error = await client.getState("gone").catch((e) => e);
  assert.ok(error instanceof MeetingApiError);
  assert.equal(error.status, 404);
  assert.equal(f.calls.length, 1);
}

{
  const f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
  const client = createMeetingClient({
    baseUrl: base,
    token: TOKEN,
    fetchImpl: f.fetch,
    sleep: noSleep,
  });
  const error = await client.end("m-1", "2026-09-21T02:00:00.000Z").catch((e) => e);
  assert.equal(error.status, 500);
  assert.equal(f.calls.length, 3, "bounded: two retries, then the caller decides");
}

// --- the token never escapes -----------------------------------------------
{
  const logged = [];
  const f = fakeFetch([
    { status: 503, body: `rejected token ${TOKEN}` },
    { status: 503, body: `rejected token ${TOKEN}` },
    { status: 503, body: `rejected token ${TOKEN}` },
  ]);
  const client = createMeetingClient({
    baseUrl: base,
    token: TOKEN,
    fetchImpl: f.fetch,
    sleep: noSleep,
    log: (message) => logged.push(message),
  });
  const error = await client.getState("m-1").catch((e) => e);
  assert.doesNotMatch(error.message, /super-secret-token/);
  assert.match(error.message, /\[REDACTED\]/);
  assert.equal(logged.join("\n").includes(TOKEN), false, "nor in a retry log line");
}

// --- misconfiguration fails at construction, not mid-meeting ---------------
assert.throws(() => createMeetingClient({ baseUrl: "", token: TOKEN }), /GASTROBRAIN_API_URL/);
assert.throws(() => createMeetingClient({ baseUrl: base, token: "" }), /MEETING_AGENT_TOKEN/);
assert.throws(
  () => createMeetingClient({ baseUrl: "http://api.example.com", token: TOKEN }),
  /must be https/,
  "a bearer token must not be sent in the clear",
);
assert.doesNotThrow(() =>
  createMeetingClient({ baseUrl: "http://localhost:8000", token: TOKEN }),
);

process.stdout.write("Gastrobrain client keeps the contract, retries what it should, hides the token.\n");
