# AGENTS.md — 商談AI (Meetron fork)

> Orientation doc for AI agents / engineers picking up this work.
> Written 2026-08-25 against our fork of `bb8ad8/meetron` at upstream `7f04a56`
> (v0.9.0). Upstream's `README.md` describes the *original* product — a bridge to
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

## 3. Current state (2026-08-25)

Installed and verified end-to-end on itsuki.son's MacBook Air (macOS 15.4.1,
arm64, Node 22.14.0, Chrome 151).

| Check | Result |
|---|---|
| Audio driver | `MeetronAIToMeeting.driver` + `MeetronMeetingToAI.driver` installed; PKG checksum, Apple signature (Yuki Inaba, SHDVCBHNJW) and notarization all verified |
| Native host | Responds to `ping` / `setup.status` over the real protocol |
| Extension | Loaded in the dedicated Chrome **and in normal Chrome `Profile 17`** (= itsuki.son@gastroduce-japan.co.jp). Only Meet pages in that profile get the panel. |
| Meet join | Requests, admitted, in call, clean `session.stop` (left + tab closed + audio restored) |
| Camera | Denied at the browser level — physically cannot transmit |
| **Virtual devices in Chrome** | **`getUserMedia` on them returns a live 48 kHz track.** The decisive test: a browser page can drive this audio path. |
| Mic toggle | Works, ~600 ms |
| Test suite | 137 checks, all pass (`npm test`) |

**Not yet built: anything that answers.** The agent side is still stock ChatGPT
automation, which we are removing. You cannot talk to it yet.

Local config (machine-specific, gitignored): `.meeting-copilot.env` holds
`MEETING_COPILOT_CDP_PORT` — the installer generates a random port per machine,
**not** the `9223` used throughout the README. Read it from the env file; do not
hardcode.

---

## 4. What we changed in the fork

One file so far: `scripts/prepare-meet.mjs` (+79/−19, uncommitted). Two real
upstream bugs that blocked every Meet join:

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

**Known limits of Stage A, none blocking a demo:**

- **55-minute cap.** OpenAI hard-limits a Realtime session to 60 minutes and the
  page closes at 55 (`MAX_SESSION_S`). A longer 商談 loses the agent at 55:00.
  Reconnecting mid-meeting is not built.
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
  local native host. Do not invest in its UI (§5.1).

### ⚠️ Identity bug you must not ship without fixing

Today the participant joins as **`itsukison00@gmail.com`, displaying "Son
Itsuki"**. When a Google account is signed in, Meet uses the account name and
never renders a name field — so Meetron's `fillParticipantName()` silently does
nothing (`participantNameFilled: false`) and the "GPT-Live" name never applies.
In a client 商談 the AI is indistinguishable from the employee. Fixed by the
shared Workspace account above.

---

## 7. Open questions and risks

- **GPL-3.0-only.** Internal use creates no obligation. Distributing a modified
  version outside the company (clients, productisation) obliges us to publish
  our source. **Unanswered by the business.** Decide before building further.
  The driver is derived from Apple's sample with its own upstream terms
  (`THIRD_PARTY_NOTICES.md`). Upstream also enforces DCO sign-off on PRs.
- **Participant consent.** The AI joins visibly, but all meeting audio reaches
  OpenAI. Who informs participants, and under what rule? **Still unanswered as
  policy**, though the calendar-invite flow (§5.1) means every invitee sees
  商談AI in the guest list before the meeting starts, which covers the mechanics.
- **【推測】 Google login from a datacenter IP** is the one finding that could
  change Stage B. Untested. See §5.0 — run it in week 1, ~1 hour, ~$5.
- **【推測】 One shared account in two simultaneous meetings** is expected to work
  but is **untested**. Note this stops being a per-person-account question and
  becomes a per-session-profile question once Stage B lands: one account, N
  Chrome profiles on one VPS.
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

```bash
npm ci
./scripts/check-env.sh                 # devices + deps; expect 0 failures
npm test                               # 137 checks, no Xcode needed

./scripts/open-control-ui-setup.sh     # launch dedicated Chrome at chrome://extensions
./scripts/open-gpt-participant.sh --auto-prepare --join "https://meet.google.com/xxx-yyyy-zzz"
./scripts/set-meet-mic.sh unmute       # goes through the session API
```

Driving the native host directly (what the extension does) is the reliable way
to exercise session commands: spawn `scripts/native-host.sh` with
`chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd/` as argv[2] and speak the
native-messaging framing (4-byte LE length + JSON).

Manual steps that cannot be automated: PKG install (admin password), restart,
loading the unpacked extension, Google/Slack logins, admitting the participant.
