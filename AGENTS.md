# AGENTS.md — 商談AI (Meetron fork)

> Orientation doc for AI agents / engineers picking up this work.
> Written 2026-08-25 against our fork of `bb8ad8/meetron` at upstream `7f04a56`
> (v0.9.0). **Revised 2026-09-07** — §3, §4, §5.1, §6 and §7 all changed. Read
> §4.1 (upstream divergence) and §6 before writing code; several things this doc
> called blockers in August are no longer blockers, and one thing it did not
> mention at all is now the top defect.
>
> **The website half of this product is not in this repo and is not yours.** It
> is being built in parallel against `../gastro/docs/MEETINGS_WEB.md`. That file
> owns the database, the pages and the HTTP API; this file owns everything that
> happens inside a meeting. The contract between them is §6 of that doc.
>
> Upstream's `README.md` describes the *original* product — a bridge to
> ChatGPT Web Voice. **We are replacing that half.** Where this file and the
> README disagree about intent, this file wins; where they disagree about how
> Meetron's plumbing works, the README and the code win.

---

## 1. What we are building

An AI participant that sits in Google Meet 商談 and:

1. **Follows the meeting** — keeps a transcript of everything said.
2. **Answers when addressed** — speaks only when called by name, and answers
   from the Gastrobrain internal knowledge base (NotePM etc.) via MCP/RAG.
3. **Reports afterwards** — sends summaries / next actions to Slack through
   trigger-based workflows, like Flownote already does.

Target users: internal Gastroduce staff (consulting / sales), Japanese-first.

**⚠️ Scope narrowed 2026-09-07: internal meetings, not client 商談.** The name
商談AI is kept, but the meetings the AI actually joins are staff-only. This is
not cosmetic — it is load-bearing for four things in this doc, all of which used
to be blockers and are now not:

| Was a blocker | Why it isn't now |
|---|---|
| GPL-3.0 distribution obligation (§7) | Never distributed outside the company — internal use creates no obligation |
| The identity bug (§6, "must not fix before shipping") | Everyone in the room is staff and knows what the AI is |
| Participant consent policy (§7) | Same — still worth a written rule, no longer gating |
| "Typing at the AI in front of a client looks bad" | Nobody is watching. Typed control is now the *primary* interface (§5.1) |

All four come back the day a client is in the room. If that changes, re-open
them together.

### Why Meetron, and what it replaces

This supersedes **Flownote** (`../flownote`), our Electron meeting assistant.
Flownote captured audio on the local machine and spent 2026-03→2026-07 fighting
macOS system audio (`audiotee`, the 16 kHz format mismatch, the "0 Speaker
segments for four months" bug — see `../flownote/AGENTS.md` §7).

Meetron sidesteps that entire problem class: instead of capturing the meeting,
**it joins the meeting as its own participant** with virtual audio devices. No
system-audio permission, no `audiotee`, no device-format guessing.

What Meetron gives us, and what it does not:

| | |
|---|---|
| ✅ Worth keeping | Virtual CoreAudio driver, dedicated Chrome, Meet/Zoom join automation (~1,900 LOC), Native Messaging host, in-meeting control UI |
| ❌ Being replaced | Its "brain". Meetron drives **ChatGPT Web Voice** by automating the DOM (`scripts/prepare-chatgpt-live.mjs`, 542 LOC) |

**The critical fact about stock Meetron: it has no text anywhere.** No
transcript, no LLM API call, no tool calling, no MCP, no API keys — grep the
repo for `transcript|mcp|api_key|slack|summar` and you get zero real hits. All
intelligence lives inside ChatGPT's web UI, which we cannot program. In
particular **ChatGPT's voice mode does not execute MCP connectors** (verified in
`../gastro/docs/VOICE_AGENT.md` §Layer 1), so goal 2 above is structurally
impossible with stock Meetron.

**Therefore: keep the shell, swap the brain.** Point the dedicated Chrome at our
own already-deployed voice agent instead of `chatgpt.com`.

### The three repos involved

```
gastroduce/
├── meetron/     ← THIS REPO. The fork. Audio + meeting participation.
├── gastro/      ← Gastrobrain. The brain: /voice page, RAG, MCP, Slack.
│                  Deployed: https://gastron-brain-web.vercel.app/ (Slack auth)
│                  Read docs/VOICE_AGENT_PLAN.md before touching the voice path.
└── flownote/    ← Predecessor. Being retired. Its Slack/workflow engine
                   (electron/services/workflow-engine.ts, slack-service.ts) is
                   the reference for goal 3.
```

---

## 2. How Meetron actually works

**Stack.** Plain Node.js ESM (`.mjs`), no TypeScript, no build step, no
framework. One runtime dependency: `playwright-core`. Plus a Chrome MV3
extension (vanilla JS), ~30 shell scripts, a Swift device CLI, and a CoreAudio
driver in C. macOS only (`"os": ["darwin"]`). **GPL-3.0-only** — see §7.

```
extension/          MV3 extension "Meetron Controls" (~1,200 LOC)
                    popup + content script on Meet/Zoom + service worker.
                    Talks to the host over nativeMessaging. Un-removable in
                    stock Meetron (the only route to the native host), but
                    **deleted in Stage B** — see §5.0. Captions are read via
                    Playwright injection, not from here (§5 Stage A item 3).
scripts/
  native-host.mjs   ⭐ The local daemon (900 LOC). ~20 JSON commands
                    (session.start/stop, participant.mic.set, setup.*,
                    diagnostics.run). Chrome spawns it via native-host.sh.
  prepare-meet.mjs  ⭐ Drives Meet's pre-join screen. WE PATCHED THIS — see §4.
  prepare-zoom.mjs  Same for Zoom Web (beta).
  prepare-chatgpt-live.mjs   ⭐ TO BE REPLACED. ChatGPT DOM automation.
  open-gpt-participant.sh    Launches the dedicated Chrome + joins.
  audio-backend.mjs          Virtual device selection/routing.
src/
  core/             session orchestrator, protocol, state
  providers/        google-meet/, zoom-web/ behind a provider contract
  platform/         macos adapter behind a platform contract
  audio/            audio backend contract
native/
  audio-driver/     CoreAudio Audio Server Plug-in (C, from Apple's sample)
  audio-control/    Swift CLI `meetron-audioctl` — enumerate/set devices only.
                    NOTE: no capture path. It cannot read PCM.
```

The contracts/registries (`provider-contract`, `platform-contract`,
`audio-backend-contract`) mean adding providers is anticipated. Only
google-meet, zoom-web and macos are implemented.

### Joining a meeting — no bot API is involved

```
① A SECOND Chrome profile is launched:
   open -na "Google Chrome" --args --remote-debugging-port=<port>
     --use-fake-ui-for-media-stream
     --user-data-dir=~/Library/Application Support/MeetingCopilot/GPTParticipantChrome
② Playwright connects over CDP to 127.0.0.1
③ Tab A  prepare-meet.mjs — selects mic/speaker via Meet's own device menu,
         forces camera off, verifies, clicks 参加をリクエスト
④ Tab B  the agent (today ChatGPT; soon our /voice page)
⑤ The user's NORMAL Chrome gets a control panel on the Meet page, which
   remote-controls the participant. It never touches the user's own mic.
```

It is a real participant joining the human way. Consequence: it depends on
Google's DOM, and it appears in the participant list (see §6).

### Audio path

Two separate loopback devices, so the agent never hears itself:

```
meeting participants → participant tab speaker (Meetron: Meeting to AI)
                     → agent page mic input   (Meetron: Meeting to AI)
agent speaks         → agent page output      (Meetron: AI to Meeting)
                     → participant tab mic    (Meetron: AI to Meeting)
                     → the meeting
```

macOS default input/output are **never changed** (`verify-routing` confirms
`meetronIsDefaultInput/Output: false`).

---

## 3. Current state (verified 2026-09-07)

Installed and verified end-to-end on itsuki.son's MacBook Air (macOS 15.4.1,
arm64, Node 22.14.0, Chrome 151).

**Everything described in this doc is committed and pushed.** Both repos are
clean and level with their remotes — nothing is stashed, uncommitted, or waiting
to be pulled:

| Repo | Remote | HEAD | State |
|---|---|---|---|
| this one | `itsukigastro/MeetingAgent` | `99e5aa9` | clean, 0 ahead / 0 behind |
| `../gastro` | `origin/main` | `36a6d65` | clean, 0 ahead / 0 behind |

| Check | Result |
|---|---|
| Audio driver | `MeetronAIToMeeting.driver` + `MeetronMeetingToAI.driver` installed; PKG checksum, Apple signature (Yuki Inaba, SHDVCBHNJW) and notarization all verified |
| Native host | Responds to `ping` / `setup.status` over the real protocol |
| Extension | Loaded in the dedicated Chrome **and in normal Chrome `Profile 17`** (= itsuki.son@gastroduce-japan.co.jp). Only Meet pages in that profile get the panel. |
| Meet join | Requests, admitted, in call, clean `session.stop` (left + tab closed + audio restored) |
| Camera | Denied at the browser level — physically cannot transmit |
| **Virtual devices in Chrome** | **`getUserMedia` on them returns a live 48 kHz track.** The decisive test: a browser page can drive this audio path. |
| Mic toggle | Works, ~600 ms |
| Test suite | **147 checks**, all pass (`npm test`) |
| Gastro web side | `tsc --noEmit` clean, `next build` clean; **33/33** tests pass (`npm run test` in `../gastro/web`) |

**What answers is built, and has never been in a meeting.** Stage A replaced the
ChatGPT automation with our own `/voice?mode=meeting` page (§5, Stage A). It was
verified by driving the page over CDP *outside* a call. The untested half is
everything that needs a room with people in it — see the Stage A limits below
and the caption-selector warning in §7.

Local config (machine-specific, gitignored): `.meeting-copilot.env` holds
`MEETING_COPILOT_CDP_PORT` — the installer generates a random port per machine,
**not** the `9223` used throughout the README. Read it from the env file; do not
hardcode.

---

## 4. What we changed in the fork

**All of it is committed** in `99e5aa9` (14 files, +1350/−832) — an earlier
revision of this doc called the `prepare-meet.mjs` work uncommitted; it is not.
That commit contains both bug fixes below *and* all of Stage A.

The two fixes below are in `scripts/prepare-meet.mjs`. They are real upstream
bugs, and each one blocked every Meet join:

1. **Role selectors return nothing while a Meet dialog is open.** An
   `aria-modal` dialog drops everything behind it out of the accessibility
   tree, so `getByRole('button')` found *zero* buttons on a page full of them.
   Now reads `aria-label` off the DOM (`labelledControlState`), which is immune.
   Upstream's own `google-meet-provider.mjs` already avoided this; the launcher
   did not.

2. **The launcher denies the camera, then cannot interpret the result.** It
   grants microphone only, and granting a permission set *replaces* the origin's
   previous set — so the camera ends up denied. Meet then swaps the camera
   button for a chip reading **"Camera: Permission needed"**, which upstream's
   camera-absent wording list (`not found|not detected|disconnected`) does not
   match. Result: `control-unavailable` → refuses to auto-join, forever, on a
   correctly working machine. A denied camera is the outcome we want, so
   `CAMERA_BLOCKED_TEXT` now treats it as definitively off.

Both are candidates for an upstream PR (see §7 re: DCO/GPL).

### 4.1 Upstream has moved — do not merge it

Checked 2026-09-07. There is **no `upstream` remote configured**, deliberately.
`bb8ad8/meetron` is now at **v0.10.1**, three commits past our fork point:

| Commit | What | Take it? |
|---|---|---|
| `fc7499b` | "Visual context for meetings" — adds `src/chatgpt/chatgpt-web.mjs` (534 LOC) | **No.** This is upstream investing further in the exact brain we deleted. |
| `998e42b` | Screenshot send-feedback effects in the extension | **No.** We are deleting the extension. |
| `8721658` | Zoom web client path fixes | **No**, unless we ever ship Zoom. |

**Merging is actively harmful**: `fc7499b` alone touches `prepare-meet.mjs`,
`native-host.mjs`, `session-launch.mjs` and `google-meet-provider.mjs` — four
files we have rewritten — and drags the ChatGPT module back in.

**But cherry-pick one hunk from `fc7499b`.** It fixes a case this doc listed in
§6 as an untested 【推測】, and upstream has now both hit it and solved it:

```js
// A Google account already present in the call gets a device-switch UI
// instead of Join now. Join as a second device so the GPT participant
// retains its own audio path; Companion mode does not provide that path.
```

When the same Google account is already in the call, Meet replaces 「今すぐ参加」
with 「その他の参加方法」→「このデバイスでも参加」. Our `prepare-meet.mjs:287-295`
matches only the former, so it waits 10 s and gives up. This will bite the moment
one shared `商談AI@` account is used for two meetings, and it is the thing that
would otherwise force a second Google identity.

**Policy: stay pinned at `7f04a56` + our commits. Pull specific hunks by hand,
never `git merge upstream/main`.**

---

## 5. The plan

> **Revised 2026-08-25 after a UX/architecture review.** The earlier plan was
> "keep the whole macOS shell, swap Tab B for our page." That still describes
> **Stage A** below, but it is no longer the destination. Stage B moves the
> participant to a **Linux VPS**, which deletes most of this repo. Read §5.0
> before writing any code, so you do not polish something that is scheduled for
> deletion.

### 5.0 The destination: a Linux VPS, not anyone's Mac

The macOS shell exists because Meetron assumed the AI runs on the user's own
laptop. That assumption is what forces the audio driver, the native host, the
extension and the setup wizard to exist. Drop the assumption and they all go.

Evidence this port is cheap, gathered from the code:

- The only macOS-specific module is `src/platform/macos/macos-platform-adapter.mjs`
  — **46 lines, entirely filesystem paths.** No audio code in it.
- `scripts/prepare-meet.mjs` and `src/providers/google-meet/google-meet-provider.mjs`
  — the ~1,900 LOC of join automation that is the actual reason we forked — contain
  **zero** references to `darwin`, CoreAudio, `meetron-audioctl` or `osascript`.
  Plain Playwright. It runs on Linux unchanged.
- The virtual audio driver has no Linux equivalent because Linux needs none:
  `pactl load-module module-null-sink` makes a sink whose `.monitor` source Chrome
  can select as a microphone. No driver, no admin password, no Apple signing, no
  notarization, no restart.
- **Concurrency inverts.** `native/audio-driver/build-driver.sh:120-135` hardcodes
  exactly two devices at compile time, so a Mac supports one meeting until you
  rebuild. On Linux, sinks are created per session with unique names — no cap.

What Stage B deletes: `prepare-chatgpt-live.mjs` (542), `native-host.mjs` (900),
`extension/` (1,617), the audio driver, `native/audio-control/` (Swift),
the 4-step setup wizard, Native Messaging, and the two-Chrome trick (a server has
one Chrome). Employees install **nothing**.

```
Google Calendar → cloud job queue → VPS: Chrome + Playwright joins Meet
                                          ↕ PulseAudio null sinks
                                    our /voice?mode=meeting (Realtime+RAG+MCP)
                                          ↓
                                    Slack: summary + next actions
```

Cost ≈ $20–40/month, ~1 CPU core per concurrent meeting. Run **real Chrome under
`xvfb`, not headless** — Meet misbehaves headless.

**【推測】 The go/no-go risk: Google login from a datacenter IP.** Signing the
shared Workspace account into Chrome on a VPS may hit a verification challenge,
and Google is stricter with automation-shaped browsers. Untested. Mitigation:
log in once by hand over VNC and keep the Chrome profile on disk forever, so it
never logs in again; the account is ours, so its security policy is ours too.
**Test this in week 1** — it is ~1 hour and ~$5, and it is the only finding that
would change Stage B.

### 5.1 Invite UX (decided)

**Primary: a Google Calendar invite.** Add `商談AI@gastroduce-japan.co.jp` to the
event exactly like a coworker. A cloud cron watches that account's calendar and
joins one minute before the start. This needs no new UI at all, and:

- Nobody pastes a URL — the Meet link rides along in the invite.
- Nobody learns anything new.
- **【推測】** An invited same-domain guest normally skips Meet's 許可 prompt, so
  the "a human must admit the participant" manual step disappears. Verify.
- Every invitee sees 商談AI in the guest list before the meeting — which answers
  the participant-consent question in §7 as a side effect.

**Backup: Slack.** For "the meeting already started, get in here", and as where
summaries come back. Reuses Flownote's existing Slack OAuth.

**No browser extension in the destination.** The extension only ever existed to
reach the native host on the local Mac. With no local Mac there is nothing for it
to reach. Do not invest in its UI.

Re-examined and re-rejected 2026-09-07, on different grounds. A control that is
pressed several times per meeting has a real claim to living inside the Meet tab,
and that would justify a small HTTPS-only extension (~200 LOC, no Native
Messaging). What killed it is the internal-meetings scope (§1): with no client
watching, **typing in the Meet chat is socially free**, so the extension buys
nothing that chat does not, and costs a per-employee install that §5.0 exists to
eliminate. If client 商談 ever come back, re-open this.

### 5.2 In-meeting control: two states, driven from Meet chat

**This section describes the current top defect and its fix. Read it before
touching `../gastro/web/src/lib/meeting-mode.ts`.**

**The defect.** `attachWakeWordGate` requires a wake-word hit on *every*
completed transcript. Real people say the name once and then keep talking:

```
「商談AI、楽天のSKU上限は？」   → answered
「じゃあAmazonは？」            → silence. The agent has already gone deaf.
```

This is not a tuning problem. A doorbell cannot hold a conversation.

**The fix: make "awake" sticky.** Two states, replacing the one-shot gate:

```
   ┌─────────┐   wake word (strict) │ 「起きて」 in chat   ┌────────┐
   │ asleep  │ ──────────────────────────────────────────▶ │  open  │
   │         │ ◀────────────────────────────────────────── │        │
   └─────────┘   「静かに」 │ 90 s with nothing addressed   └────────┘
```

| State | Behaviour |
|---|---|
| **asleep** (default) | Listens and transcribes; never speaks. Only a strict wake-word match wakes it. |
| **open** | Answers anything question-shaped without needing the name. Each answer resets the 90 s timer. |

Decided details:

- **90 s idle timeout out of `open`.** Without it somebody opens the agent,
  forgets, and it starts answering questions nobody asked it.
- **No separate "muzzled" state.** `asleep` already *is* the muzzle — it does not
  speak. The only thing a hard muzzle would add is deafness to the wake word,
  which matters only if the wake word misfires often. With chat as a reliable
  entry point it should not. Add it later if reality disagrees.
- **`interruptResponse` stays `false` in both states**, for the reason already
  given in Stage A — a cough must not cut the agent off mid-sentence.

**Meet chat is the control surface, and also a question channel.** The
realisation worth keeping: typed text has *no transcription error at all*.

```
「商談AI 楽天のSKU上限は？」   typed  → always works. No wake word, no gate.
「商談AI、楽天のSKU上限は？」   spoken → convenient, sometimes missed.
```

So chat is the path that never fails and voice is the path that is pleasant. The
reader is the same shape as `src/providers/google-meet/meet-captions.mjs` —
a Playwright-injected DOM walk over a different container — so budget it as an
hour, not a project.

**Consequence for the wake word: it has been demoted.** It no longer has to be
accurate, only handy, because chat is always available as the reliable way in.
Do not spend time chasing 100 % recall on 商談AI; see §6.

#### How it is wired (built 2026-09-07)

Three pieces, in two repos, joined by one contract:

```
Meet tab                      meet-chat-bridge.mjs           agent tab
─────────                     ────────────────────           ─────────
meet-chat.mjs collector  ──▶  drainMeetChat(meetPage)
  polls the chat panel        for each message:
  primes on install,            agentPage.evaluate(…)  ──▶  window.meetingControl
  never replays history                                        .command(text)
                                                                   │
                                                        parseChatCommand decides
                                                        quiet / wake / ask / ignored
```

- **`src/providers/google-meet/meet-chat.mjs`** — the collector. Same injection,
  polling and drain shape as `meet-captions.mjs`. Two differences, both because
  chat is append-only where captions are rewritten in place: no settle timer,
  and a **priming pass on install** so joining a meeting does not replay an
  hour-old 「商談AI 静かに」 as a fresh command. `drainMeetChat` samples before
  reading, so a command never waits a poll tick.
- **`scripts/meet-chat-bridge.mjs`** — the long-running wire. Its own script
  rather than a branch of `native-host.mjs`, which Stage B deletes; this is
  plain Playwright over CDP and ports unchanged. `--once` drains a single batch,
  which is what makes it testable.
- **`window.meetingControl`** — published by the page in meeting mode, the same
  way `data-meetingStatus` already is. `state()`, `set()`, `ask()`, `command()`.

**The page owns what a message means, not Meetron.** The bridge forwards raw
text and logs the verdict; the aliases, the 「静かに」 matching and the decision to
ignore a message all live in `meeting-mode.ts`, next to the state they change and
covered by its tests. Adding a command means editing one TypeScript file, not
touching this repo.

Also published: **`data-meetingAgentState`** = `asleep | open`, a separate
attribute from `data-meetingStatus` so the existing launcher contract is
untouched.

⚠️ **The chat panel must be open** or Meet renders no messages into the DOM at
all, and the control surface silently does not exist. `prepare-meet.mjs` opens it
on join; the bridge opens it again on start, for a meeting it is attached to
after the fact.

#### ⚠️ When the cloud poller is built: make it edge-triggered

Not yet written — this is a note for whoever builds Stage B item 5.

The web UI also sets the agent state, and the contract
(`../gastro/docs/MEETINGS_WEB.md` §6) has the VPS **poll** `GET /v1/meetings/{id}/state`
rather than receive a callback. The 90 s expiry is owned by this side. Those two
facts fight each other if the poller applies the polled value on every read:

```
UI sets open      → DB says open
poll → gate opens
90 s idle         → gate goes asleep      (our timer)
poll → DB still says open → gate re-opens
…every 3 s, forever. The timeout never takes effect.
```

**Both halves are required. Do not remove either as redundant:**

1. **Apply the polled value only when it changes** from the last value seen, not
   on every read. This protects the local timer from a stale read.
2. **Write the state back.** `PATCH /v1/meetings/{id}` with
   `X-Meeting-Agent-Token` accepts `{status?, started_at?, agent_state?}`, and
   `agent_state` is ours to write **in both directions** — not only the expiry.
   A strict wake word heard in the room opens the gate, so that must be written
   back too, or the UI shows asleep against an answering agent.

The browser writes through `POST /v1/meetings/{id}/state` instead, and is
refused `agent_state` on `PATCH` (403). One write path per caller, so "who last
set this" stays readable.

Raised and settled with the web side 2026-09-07 — the endpoint originally
rejected the field, which would have made the 90 s expiry a no-op in production.

### 5.3 Build order for the meeting side

The website half runs in parallel against `../gastro/docs/MEETINGS_WEB.md` and
does not block any of this.

| # | Task | Where | Status |
|---|---|---|---|
| 1 | Two-state machine, replacing `attachWakeWordGate` | `../gastro/web/src/lib/meeting-mode.ts` | **done 2026-09-07** |
| 2 | Meet chat reader | `src/providers/google-meet/meet-chat.mjs` | **done 2026-09-07** |
| 3 | Wire chat commands + typed questions into the machine | `scripts/meet-chat-bridge.mjs` | **done 2026-09-07** |
| 4 | Cherry-pick the `fc7499b` join hunk | `scripts/prepare-meet.mjs` | **done 2026-09-07** |
| 5 | **First real meeting** — validates 1–3, the caption selectors (§7) and the audio path in one sitting | — | **blocked on a human** |
| 6 | VPS Google-login test (§5.0), ~1 h, ~$5 | — | not started |

Items 5 and 6 are the only ones left, and neither is code. Item 5 is what
converts guesses into facts: everything still marked 【推測】 or "unverified" in
this doc resolves there.

**Two incidental fixes made along the way, both worth knowing about:**

- `../gastro/web/src/lib/wake-word.ts` contained a **raw NUL byte** (`BOUNDARY`
  was written as a literal `\x00` rather than the escape). Git classified the
  file as binary — it appears as `Bin 0 -> 7278 bytes` in `99e5aa9` — so it had
  no diffs, no merges and no reviewable history. Replaced with `"\u0000"`;
  behaviour is identical.
- `meeting-mode.ts` imported `"./wake-word"` with no extension, which webpack
  resolves and bare Node ESM does not. That is why the module had **no tests at
  all** until now. Now `"./wake-word.ts"`; `next build` verified.

**Known flake:** `tests/prepare-zoom-test.mjs` fails intermittently under load
now that two more Chrome-launching tests exist. Passes 3/3 in isolation and the
full suite passed twice consecutively. Pre-existing; not caused by, but made
more visible by, the new tests.

### Stage A — working demo on this Mac (week 1)

Goal: something demo-able fast, built so that almost nothing is thrown away.

**Code complete 2026-08-26. Verified live outside a meeting; not yet in one.**

Confirmed by driving the deployed page in the dedicated Chrome over CDP:
`data-meetingStatus="listening"`, header 商談AI（会議モード）, gate showing
待機中, and the output audio element's `sinkId` bound to **Meetron: AI to
Meeting** with a live, playing track. So the deploy, both logins, device
binding, the Realtime connection and the wake-word gate all work. What remains
unproven is everything that needs a room with people in it: caption selectors,
whether the wake word fires on real speech, and whether the meeting actually
hears the agent.

Note both loopback devices enumerate as *each* of `audioinput` and
`audiooutput`, so selection must filter on `kind` as well as label — picking by
label alone silently binds the agent's ear to its own mouth.

What exists:

| Built | Where | Verified by |
|---|---|---|
| Wake-word matcher | `../gastro/web/src/lib/wake-word.ts` | 14 unit tests, `npm run test` |
| Meeting mode (devices + gating + auto-start) | `../gastro/web/src/lib/meeting-mode.ts`, wired into `voice-session.tsx` | typecheck + `next build` |
| Agent launcher, replacing the ChatGPT automation | `scripts/prepare-agent.mjs`, `scripts/open-agent.sh` | `tests/unified-profile-test.mjs` |
| Caption capture | `src/providers/google-meet/meet-captions.mjs`, called from `prepare-meet.mjs` | `tests/meet-captions-test.mjs` (synthetic DOM) |

**Deleted**: `prepare-chatgpt-live.mjs` (542 LOC), `open-chatgpt-live.sh`, and the
ChatGPT branches of `native-host.mjs`. The repo no longer references chatgpt.com.

Design notes worth keeping:

- **The page reports its own state.** `document.documentElement.dataset.meetingStatus`
  is `connecting | listening | answering | error | ended`. `prepare-agent.mjs` and
  `native-host.mjs` read that one attribute instead of inspecting a foreign UI —
  which is why the launcher is ~140 lines where the ChatGPT one was 542.
- **Both `turnDetection` flags are off in meeting mode**, for two different
  reasons. `createResponse: false` is the wake-word gate. `interruptResponse: false`
  is separate and just as necessary: left on, any cough or side remark cuts the
  agent off, so it never finishes a sentence in a room full of people.
- **Mic model (decided)**: the Meet mic stays **unmuted all meeting**; silence is
  the page's job. The panel's manual mute remains only as an emergency stop.
- **The agent URL is defaulted**, so the wizard's ChatGPT step is dead weight
  rather than a prerequisite. Override with `MEETING_COPILOT_AGENT_URL`; a URL
  without `mode=meeting` is refused at three layers, because that flag is the
  only thing standing between a 商談 and an agent that answers every utterance.

**Hacked minimally — these die in Stage B, so they were not improved:**

`native-host.mjs` keeps the command names the extension already sends
(`setup.open.chatgpt`, `voice.restart`) and still returns a `chatgpt` alias in its
status payload, so the floating panel keeps working untouched. The setup wizard
was not opened.

**Known limits of Stage A:**

- ~~**The agent answers once, then goes deaf.**~~ **Fixed 2026-09-07** by the
  two-state machine in §5.2. Regression test:
  `../gastro/web/src/lib/meeting-mode.test.ts`, "answers a follow-up that does
  not repeat the name".
- **55-minute cap.** OpenAI hard-limits a Realtime session to 60 minutes and the
  page closes at 55 (`MAX_SESSION_S`). A meeting longer than that loses the agent
  at 55:00. Reconnecting mid-meeting is not built. Internal meetings routinely
  run 60 min, so this will be hit before most other open items.
- **Caption selectors are unverified against live Meet.** See §7.

**Still parallel, because they depend on other people:** the VPS Google-login
test in §5.0, and the shared Workspace account in §6.

### Stage B — move to the VPS (week 2+)

1. `src/platform/linux/linux-platform-adapter.mjs` — mirror of the 46-line macOS
   adapter, different paths.
2. A PulseAudio audio backend behind the existing `defineAudioBackend` contract
   (`src/audio/audio-backend-contract.mjs`, 44 lines) — `pactl` in place of
   `meetron-audioctl`, one sink pair per session.
3. Chrome under `xvfb`; one profile per concurrent session.
4. Replace the native host with an HTTP job queue the cloud can post to; delete
   the extension and Native Messaging.
5. Calendar watcher → job queue → session.

### Stage C — Slack reporting

Reuse Flownote's Slack OAuth (a Supabase Edge Function) and workflow model.
Both triggers become cloud-side once the participant lives on the VPS —
the "会議終了 must be local because only the native host knows" constraint
disappears with the native host.

### Dashboard shape (revised)

**No Electron** — unchanged, and now doubly true.

```
Cloud web (Next)  → everything: invites, /voice, workflows, Slack, history,
                    knowledge, permissions, session monitoring
VPS worker        → Chrome + Playwright + null sinks. No UI.
```

The earlier note that "a pure website cannot be the control surface — it cannot
reach the driver or CDP" was true **only while the driver ran on the user's Mac.**
Once the participant runs on a server the cloud talks to it directly, and a pure
website is exactly the right control surface. The extension is likewise no longer
un-removable.

## 6. Decisions taken

- **Wake words**: 商談AI (read しょうだんエーアイ) and ガストロブレイン. Match
  normalized text and accept mishearings (商談エーアイ / しょうだんエーアイ /
  ショウダンエーアイ / ガストロブレーン …). Keep the matcher in a separately
  testable module so the list can be tuned without redeploying blind.

  **Revised 2026-09-07 — stop trying to make this accurate.** The alias list
  cannot be completed. Transcription returns 昇段AI, 笑談え〜愛, 消壇AI,
  しょうたんえーあい and an open-ended tail of others. Two approaches were
  considered and both rejected:

  | Idea | Why not |
  |---|---|
  | Match on the *reading* instead of the characters | Correct in principle — 商談/昇段/笑談 all read しょうだん — but kanji→reading needs morphological analysis (kuromoji, ~12 MB dictionary), and it still misses せんだん / しょうたん. Large dependency, still not 100 %. |
  | Keep extending the alias list | Unbounded. Every miss is found in production, in a meeting, by a person who then stops trusting it. |

  **What we did instead: removed the requirement.** Meet chat (§5.2) is an
  always-available, transcription-free way to reach the agent, so the wake word
  only has to be *handy*, not reliable. Leave `wake-word.ts` as it is.

  One asymmetry worth encoding if it is ever tuned: **waking and quieting are
  not equally risky.** A false wake interrupts the room; a false quiet is
  harmless. So match the wake word strictly and 「静かに」 loosely.
- **Corpus gating for the agent (asked 2026-08-26): already handled, no work
  needed.** HR, 経理 and 法務 notebooks are excluded at *ingestion*, so they are
  not in the corpus and no login can retrieve them — see
  `../gastro/config/notepm_excluded_notes.yaml` (031_人事労務, 033_採用全般,
  033-1/2/3_社内人事, 030_経理, 030-1_経理-マネージャー連携, 023_法務).
  Everything else the Gastrobrain user may see, the agent may see. Neither
  loosening nor tightening is required for meeting mode.
- **Transcript source**: Google Meet captions (speaker-labelled), rather than
  the Realtime input transcription (one mixed stream, no speaker labels). Scraped
  by **Playwright injection inside `prepare-meet.mjs`**, not by the extension
  content script — the extension does not exist in Stage B. The agent should
  switch captions on at join so nobody has to remember.
- **Accounts.** The dedicated Chrome needs **two separate logins**, often
  confused for one:
  1. **Google** — to join the Meet.
  2. **Gastrobrain (Supabase/Slack OAuth)** — to load `/voice`; see
     `../gastro/web/src/lib/auth-guard.ts`. Whoever is signed in here determines
     **which knowledge the AI can read** (per-user ACL). A future shared account
     needs its own permissions decided; for Stage A it inherits Itsuki's.

  **Destination**: one shared Workspace account, `商談AI@gastroduce-japan.co.jp`,
  for both. It makes the AI visibly not-a-person in the participant list, and on
  the VPS it is the only login that exists at all — one profile, not one per
  employee. Blocked on admin creating it.

  **Stage A (decided 2026-08-26)**: do not wait for admin.
  - **Google/Meet login** → `itsukison@fuji.waseda.jp`. The operator joins with
    their Gastroduce account, so the AI needs a *different* Google identity —
    otherwise one account joins the same meeting twice (【推測】 Meet may refuse
    or misbehave; untested) and the participant list shows two "Son Itsuki".
    Consequence: the AI is an **external guest**, so a human must click 許可 to
    admit it. Acceptable for a demo.
  - **Gastrobrain login** → `itsuki.son@gastroduce-japan.co.jp`. Not a choice:
    `../gastro/web/src/app/login/page.tsx:15` offers `provider: "slack_oidc"`
    only, so a non-Gastroduce address cannot sign in at all.

  ⚠️ **The two logins are independent.** The Google account has no bearing on
  what the AI can read; corpus access comes entirely from the Gastrobrain
  identity's `AccessScope(user_code, slack_user_id)`
  (`../gastro/src/gastrobrain/auth.py:202`). Signing Meet in with an outside
  Google account does **not** sandbox the agent.
  ⚠️ Still **internal demos only** until the shared Workspace account exists —
  the AI shows a personal name, not a company one.
- **Where the participant runs**: a **Linux VPS**, not employee laptops (§5.0).
  Reached in two stages — a macOS demo first (Stage A), then the port (Stage B).
- **How meetings are invited**: a **Google Calendar invite** to the account
  above, with **Slack** as the ad-hoc backup and the reporting channel (§5.1).
- **Mic model**: the Meet mic stays **unmuted for the whole meeting**; staying
  quiet is the /voice page's job, not the mute button's. Stock Meetron did the
  opposite — permanently muted, with a human pressing 「ミュート解除」 to let it
  speak, because prompt instructions could not restrain a DOM-driven ChatGPT
  (upstream `README.md:226` says so outright). We control our page, so we gate
  inside it. The panel's manual mute survives only as an emergency stop.
- **No browser extension in the destination.** It existed solely to reach the
  local native host. Do not invest in its UI (§5.1). Re-confirmed 2026-09-07 on
  separate grounds — see §5.1.

**Decided 2026-09-07:**

- **Scope: internal meetings, not client 商談** (§1). Four previously-blocking
  items collapse as a result; the table in §1 lists them and the condition under
  which each returns.
- **Never sold or distributed outside the company.** This closes the GPL-3.0
  question that had been open since August — internal use creates no source
  obligation. It also settles where the web UI lives (below).
- **The agent stays awake once woken**, for 90 s of idle (§5.2). Replaces the
  one-shot gate, which was the top defect.
- **No separate hard-muzzle state.** `asleep` already does not speak (§5.2).
- **Meet chat is the in-meeting control surface** *and* a transcription-free way
  to ask questions (§5.2). Not a browser extension.
- **The web UI lives inside the existing Gastrobrain site**, not a new one. The
  permission model that decides what the agent may read is already there
  (`AccessScope`, folder ACLs, Slack OIDC); a second site would have to
  reimplement or federate it, which is how permission bugs happen. Spec for the
  other agent: `../gastro/docs/MEETINGS_WEB.md`.

### ⚠️ Identity bug — downgraded 2026-09-07, still worth fixing

Today the participant joins as **`itsukison00@gmail.com`, displaying "Son
Itsuki"**. When a Google account is signed in, Meet uses the account name and
never renders a name field — so Meetron's `fillParticipantName()` silently does
nothing (`participantNameFilled: false`) and the "GPT-Live" name never applies.

This was "must not ship without fixing" while the target was client 商談. With
the internal-meetings scope (§1) it is no longer a blocker — colleagues know
what the AI is, and a second "Son Itsuki" in the list is confusing rather than
deceptive. Still fix it via the shared Workspace account, because §4.1's
double-join case and the one-account-N-profiles model in §5.0 both want that
account to exist anyway. **It becomes a blocker again the moment a client is in
the room.**

---

## 7. Open questions and risks

- ~~**GPL-3.0-only.**~~ **Closed 2026-09-07.** The business confirmed this is
  never sold or distributed outside the company. Internal use of a modified
  GPL-3.0 work creates no obligation to publish source, so nothing here is
  blocked. Two things still hold: the driver carries Apple's own upstream terms
  (`THIRD_PARTY_NOTICES.md`), and upstream enforces DCO sign-off if we ever send
  the §4 fixes back as a PR. **Re-open only if productisation is ever revisited.**
- **Participant consent** — downgraded, not closed. All meeting audio still
  reaches OpenAI. With internal-only meetings (§1) this stops being a client
  disclosure problem and becomes an ordinary internal-policy question: staff
  should be told, once, in writing, that 商談AI in the guest list means the audio
  leaves the building. The calendar-invite flow (§5.1) already covers the
  mechanics — every invitee sees it before the meeting. **Someone still needs to
  write the one-paragraph rule.** Not blocking.
- **【推測】 Google login from a datacenter IP** is the one finding that could
  change Stage B. Untested. See §5.0 — run it in week 1, ~1 hour, ~$5.
- **One shared account in two simultaneous meetings** — partially answered by
  upstream. `fc7499b` (§4.1) shows Meet swaps 「今すぐ参加」 for a device-switch UI
  when the same account is already in a call, and ships the handling for it. So
  the failure mode is now known and has a known fix; what stays **untested** is
  whether two *different* meetings on one account behave. Once Stage B lands this
  is a per-session-profile question: one account, N Chrome profiles on one VPS.
- ~~**Install cost scales linearly.**~~ **Resolved by §5.0.** Stage B has
  employees install nothing — no driver, no admin password, no restart, no Node,
  no second Chrome, no hand-loaded extension. This risk applies to Stage A only,
  which runs on one machine (itsuki.son's) by design.
- **DOM fragility.** Removing the ChatGPT automation deleted most of it, but
  Meet/Zoom pre-join automation remains exposed to Google's UI changes.
- **⚠️ Caption selectors are unverified against a live meeting.** The collector
  in `src/providers/google-meet/meet-captions.mjs` is tested against a synthetic
  DOM, which proves the *logic* (a line growing word by word is recorded once and
  in full; a reused slot does not swallow the previous utterance; speaker names
  survive) but cannot prove the *selectors* match today's Meet. Everything
  version-specific is confined to `CAPTION_REGION_SELECTORS` and the structural
  walk in `collectorSource`. **First real meeting: join, talk, then read
  `drainMeetCaptions(page)` over CDP.** If `region` comes back empty, the
  selector list is what needs updating — nothing else.

---

## 8. Gotchas learned the hard way

Read these before debugging anything Meet-related; each one cost real time.

- **A modal dialog blanks every role-based selector.** `getByRole` returns 0
  matches while an `aria-modal` dialog is open, even for plainly visible
  buttons. Symptom: "control-unavailable" everywhere. Use `aria-label` via
  `page.evaluate`, or `[data-is-muted]`.
- **`grantPermissions(['microphone'])` denies the camera** — the set replaces
  the origin's previous permissions. This is desirable, but changes Meet's UI.
- **The mic flips back to muted every 2 seconds.** The content script calls
  `session.reconcile` on an interval and enforces the persisted session state.
  If you drive things through `open-gpt-participant.sh` without a real session,
  the reconcile loop will fight you. Not a bug — drive it via the session API.
- **Meet's control bar animates**, so `locator.click()` times out on "visible,
  enabled and stable". Use `{force: true}`; a plain DOM `element.click()` does
  **not** reliably trigger Meet's handlers.
- **`data-is-muted` briefly reports the wrong value** while Meet wires a control
  up. Derive state from *which* label is present, not from the attribute.
- **In-call there are two `[data-is-muted]` elements** (mic and camera).
  `querySelector` order is mic-first in call, but do not rely on it — filter by
  `aria-label`.
- **The CDP port is random per machine.** Read `.meeting-copilot.env`.
- Debug scripts used during this work are throwaway; connect over CDP with
  `scripts/playwright-cdp.mjs` and inspect via `page.evaluate`.

---

## 9. Running it

### Once per machine

```bash
npm ci
./scripts/check-env.sh                 # devices + deps; expect 0 failures
npm test                               # 147 checks, no Xcode needed
```

Then sign the dedicated Chrome profile into **two** accounts, once each — they
are unrelated and both are required (§7): **Google**, which joins the Meet, and
**Gastrobrain** via Slack OIDC, which loads `/voice` and decides what corpus the
agent may read.

### Every meeting — five commands, in this order

```bash
./scripts/open-control-ui-setup.sh     # dedicated Chrome, CDP on 9223
./scripts/open-agent.sh                # agent tab: /voice?mode=meeting
./scripts/open-gpt-participant.sh --auto-prepare --join "https://meet.google.com/xxx-yyyy-zzz"
node scripts/meet-chat-bridge.mjs \
  --agent-url "https://gastron-brain-web.vercel.app/voice?mode=meeting"
./scripts/set-meet-mic.sh unmute
```

The order is load-bearing. `open-agent.sh` must come before the bridge, because
the bridge finds the agent tab by URL and exits if it is not there; the Meet tab
must exist before it too, for the same reason.

`--auto-prepare` does more than open a tab: it binds the two Meetron loopback
devices, turns captions on, opens the chat panel and installs **both**
collectors (`meet-captions.mjs` and `meet-chat.mjs`). A human still has to admit
the participant.

**Do not skip the bridge.** It is the only thing carrying Meet chat into
`window.meetingControl` — without it the agent joins, hears everything and can
never be woken, quieted or asked anything.

### Driving it during the meeting

Everyone types into normal Meet chat; there is nothing to install:

| Typed in chat | Effect |
| --- | --- |
| `商談AI 起きて` | state → `open` |
| `商談AI 静かに` | state → `asleep` |
| `商談AI <question>` | answers it, and opens the gate |

While `open`, follow-ups are answered **without** repeating the name until 90 s
of silence puts it back to sleep (§5.2). `asleep` is the muzzle — there is no
third state.

### Watching it from outside the page

The agent tab publishes its own state on `<html>`, and that is the entire
contract between the page and Meetron:

- `data-meeting-status` = `connecting | listening | answering | error | ended`
- `data-meeting-agent-state` = `asleep | open`

Over CDP with `scripts/playwright-cdp.mjs`, `document.documentElement.dataset`
is the fastest way to see what the agent thinks is happening.

### First real meeting — the three things only a live call can settle

Everything else is covered by tests; these are not, and each has a cheap check
(§7):

1. **Do the caption selectors still match Meet?** `drainMeetCaptions(page)` over
   CDP. If `region` comes back empty, only `CAPTION_REGION_SELECTORS` needs
   changing — the collector logic is already proven.
2. **Does the chat path work end to end?** Type `商談AI 起きて` and watch
   `data-meeting-agent-state` flip to `open`. The bridge logs every message it
   hands over.
3. **Does audio actually route both ways?** The room hears the agent, and the
   agent's transcript shows the room's words.

### Manual steps that cannot be automated

PKG install (admin password), the restart it wants, the two logins above, and
admitting the participant into the call.
