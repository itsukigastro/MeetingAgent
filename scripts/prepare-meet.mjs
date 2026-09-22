#!/usr/bin/env node

import { getAudioStatus } from "./audio-backend.mjs";
import { connectToChromeOverCDP } from "./playwright-cdp.mjs";
import {
  activateLocator,
  clickFirstVisible,
  closeOtherPages,
  firstBrowserContext,
  locatorIsVisible,
} from "../src/browser/meeting-browser.mjs";
import {
  exactDevicePattern,
  resolveMeetingAudioDevices,
} from "../src/audio/meeting-audio-devices.mjs";
import {
  parsePreparationOptions,
  PREPARATION_EXIT_CODES,
  preparationUsage,
} from "../src/core/preparation-cli.mjs";
import { createPreparationResult } from "../src/core/participant-state.mjs";
import {
  enableCaptions,
  installCaptionCollector,
} from "../src/providers/google-meet/meet-captions.mjs";
import {
  installChatCollector,
  openChatPanel,
} from "../src/providers/google-meet/meet-chat.mjs";

const CONTROLLER_EXTENSION_ID = "jlikakgdldiihhflkobhnpfegjlcakdd";

function usage() {
  process.stdout.write(preparationUsage({
    providerLabel: "Google Meet",
    scriptName: "prepare-meet.mjs",
  }));
}

let options;
try {
  options = parsePreparationOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  usage();
  process.exit(2);
}
if (options.help) { usage(); process.exit(0); }

if (!options.url.startsWith("https://meet.google.com/")) {
  process.stderr.write("A Google Meet URL is required with --url.\n");
  process.exit(2);
}

Object.assign(options, await resolveMeetingAudioDevices(options, getAudioStatus));

const browser = await connectToChromeOverCDP(options.cdp);
const context = await firstBrowserContext(browser);
await context.grantPermissions(["microphone"], {
  origin: "https://meet.google.com",
});

const controllerWorker = context
  .serviceWorkers()
  .find((worker) => worker.url().startsWith(`chrome-extension://${CONTROLLER_EXTENSION_ID}/`));
if (controllerWorker) {
  await controllerWorker.evaluate(() => chrome.storage.local.set({ controlsCollapsed: true }));
}

const meetPages = context
  .pages()
  .filter((candidate) => candidate.url().startsWith("https://meet.google.com/"));
let page = meetPages.find((candidate) => candidate.url().startsWith(options.url));
await closeOtherPages(meetPages, page);

if (!page) {
  page = await context.newPage();
  await page.goto(options.url, { waitUntil: "domcontentloaded" });
}

await page.bringToFront();
await page.waitForLoadState("domcontentloaded");
page.setDefaultTimeout(5_000);

async function fillParticipantName() {
  const fields = [
    page.getByLabel(/^(名前|Name)$/i),
    page.getByPlaceholder(/名前を入力|名前/i),
    page.getByPlaceholder(/your name|name/i),
    page.getByRole("textbox"),
  ];

  for (const field of fields) {
    try {
      if ((await field.count()) === 1 && (await field.isVisible())) {
        await field.fill(options.name);
        return true;
      }
    } catch {
      // Try the next field.
    }
  }
  return false;
}

const microphoneOnboardingButtons = [
  page.getByRole("button", { name: /マイクの使用/ }),
  page.getByRole("button", { name: /use (the )?microphone|use mic/i }),
];

// The onboarding dialog can appear after the first DOMContentLoaded event.
try {
  await Promise.race(
    microphoneOnboardingButtons.map((button) =>
      button.first().waitFor({ state: "visible", timeout: 5_000 }),
    ),
  );
} catch {
  // Granting the permission can dismiss the dialog before it becomes visible.
}

const usedMicrophone = await clickFirstVisible(microphoneOnboardingButtons);

await page.waitForTimeout(500);

async function selectAudioDevice({ buttonName, menuName, targetName }) {
  const button = page.getByRole("button", { name: buttonName }).first();
  await button.waitFor({ state: "visible", timeout: 15_000 });
  let currentLabel = (await button.getAttribute("aria-label")) || "";
  if (!targetName.test(currentLabel)) {
    await button.click();
    const menu = page.getByRole("menu", { name: menuName });
    await menu.getByRole("menuitemradio", { name: targetName }).click({ timeout: 5_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      currentLabel = (await button.getAttribute("aria-label")) || "";
      if (targetName.test(currentLabel)) break;
      await page.waitForTimeout(100);
    }
  }
  if (!targetName.test(currentLabel)) {
    throw new Error(`Meet did not select the required audio device: ${targetName}`);
  }
  return currentLabel;
}

const microphoneDevice = await selectAudioDevice({
  buttonName: /^(マイク|Microphone):/i,
  menuName: /マイク|Microphone/i,
  targetName: exactDevicePattern(options.microphoneDevice),
});

const speakerDevice = await selectAudioDevice({
  buttonName: /^(スピーカー|Speaker):/i,
  menuName: /スピーカー|Speaker/i,
  targetName: exactDevicePattern(options.speakerDevice),
});

const nameFilled = await fillParticipantName();

async function visibleControlState({ on, off }) {
  if (await locatorIsVisible(on)) {
    return "off";
  }
  if (await locatorIsVisible(off)) {
    return "on";
  }
  return "unavailable";
}

// Meet's pre-join toggles are readable two ways, and the accessible name is the
// fragile one: while a modal dialog is open (the waiting-room "Are you still
// there?" prompt, for one) everything outside it drops out of the accessibility
// tree, so getByRole() returns nothing and a control that is plainly on screen
// reads as missing — which is what stopped the launcher before admission.
// Reading aria-label straight off the DOM is immune to that. State comes from
// which label is present rather than from data-is-muted, because that attribute
// briefly reports the wrong value while Meet is still wiring the control up.
async function labelledControlState({ onLabel, offLabel }) {
  return page.evaluate(({ on, off }) => {
    const onMatcher = new RegExp(on, "i");
    const offMatcher = new RegExp(off, "i");
    for (const node of document.querySelectorAll("[aria-label]")) {
      if (node.getClientRects().length === 0) continue;
      const label = node.getAttribute("aria-label") || "";
      if (onMatcher.test(label)) return "off";
      if (offMatcher.test(label)) return "on";
    }
    return "unavailable";
  }, { on: onLabel.source, off: offLabel.source }).catch(() => "unavailable");
}

// Meet also renders these controls progressively, so poll rather than sample once.
async function settledControlState(controls, { timeout = 10_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  const read = async () => {
    const state = await labelledControlState(controls);
    return state === "unavailable" ? visibleControlState(controls) : state;
  };
  let state = await read();
  while (state === "unavailable" && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
    state = await read();
  }
  return state;
}

const MICROPHONE_ON_LABEL = /マイクをオン(?:にする)?|turn on microphone|unmute microphone/i;
const MICROPHONE_OFF_LABEL = /マイクをオフ(?:にする)?|マイクをミュート|turn off microphone|mute microphone/i;
const CAMERA_ON_LABEL = /カメラをオン(?:にする)?|turn on camera/i;
const CAMERA_OFF_LABEL = /カメラをオフ(?:にする)?|turn off camera/i;

const turnMicrophoneOn = page.getByRole("button", { name: MICROPHONE_ON_LABEL });
const turnMicrophoneOff = page.getByRole("button", { name: MICROPHONE_OFF_LABEL });
const microphoneControls = {
  on: turnMicrophoneOn,
  off: turnMicrophoneOff,
  onLabel: MICROPHONE_ON_LABEL,
  offLabel: MICROPHONE_OFF_LABEL,
};
let microphoneState = await settledControlState(microphoneControls);
if (microphoneState === "on") {
  await turnMicrophoneOff.first().click();
  await page.waitForTimeout(300);
  microphoneState = await settledControlState(microphoneControls, { timeout: 2_000 });
}
if (microphoneState !== "off") {
  throw new Error("Meet microphone could not be verified as muted before admission.");
}

const turnCameraOn = page.getByRole("button", { name: CAMERA_ON_LABEL });
const turnCameraOff = page.getByRole("button", { name: CAMERA_OFF_LABEL });
const cameraControls = {
  on: turnCameraOn,
  off: turnCameraOff,
  onLabel: CAMERA_ON_LABEL,
  offLabel: CAMERA_OFF_LABEL,
};
let cameraState = await settledControlState(cameraControls);
if (cameraState === "on") {
  await turnCameraOff.first().click();
  await page.waitForTimeout(300);
  cameraState = await settledControlState(cameraControls, { timeout: 2_000 });
}
if (cameraState === "on") {
  throw new Error("Meet camera could not be disabled before admission.");
}
// This launcher grants only the microphone, and granting a permission set
// replaces the origin's previous one — so the camera ends up denied. That is the
// outcome we want (a denied camera cannot transmit), but Meet then swaps the
// camera toggle for an error chip reading "Camera: Permission needed" instead of
// the "not found" wording below, leaving no control to inspect. Treat a blocked
// camera as definitively off; only a genuinely unreadable control should stop
// the launch and ask a person to look.
const CAMERA_ABSENT_TEXT = /カメラ.*(?:見つかりません|使用できません|利用できません|接続されていません)|(?:camera|webcam).*(?:not found|unavailable|not available|not detected|disconnected)/i;
const CAMERA_BLOCKED_TEXT = /カメラ.*(?:問題|権限|許可|ブロック)|(?:権限|アクセス).*(?:必要|許可されていません)|(?:camera|webcam).*(?:problem|permission|blocked|denied)|permission needed/i;

if (cameraState === "unavailable") {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const labelText = await page.evaluate(() =>
    [...document.querySelectorAll("[aria-label]")]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => node.getAttribute("aria-label"))
      .join("\n")).catch(() => "");
  const cameraText = `${bodyText}\n${labelText}`;
  cameraState = CAMERA_ABSENT_TEXT.test(cameraText) || CAMERA_BLOCKED_TEXT.test(cameraText)
    ? "unavailable"
    : "control-unavailable";
}

const microphoneButton = page.getByRole("button", {
  name: /^(マイク|Microphone):/i,
});
const speakerButton = page.getByRole("button", {
  name: /^(スピーカー|Speaker):/i,
});

const resolvedMicrophoneDevice =
  (await microphoneButton.getAttribute("aria-label")) || microphoneDevice;
const resolvedSpeakerDevice =
  (await speakerButton.getAttribute("aria-label")) || speakerDevice;

let connection = "prejoin";
let actionRequired = null;
if (options.join) {
  if (cameraState === "control-unavailable") {
    connection = "manual-action-required";
    actionRequired = "camera-check";
  } else if (nameFilled) {
    connection = "manual-action-required";
    actionRequired = "google-login";
  } else {
    const joinButton = page.getByRole("button", {
      name: /参加をリクエスト|今すぐ参加|ask to join|join now/i,
    });
    // When the same Google account is already in the call, Meet does not offer
    // "join now" at all — it offers to move the call to this device, behind
    // 「その他の参加方法」. Cherry-picked from upstream `fc7499b`; see AGENTS.md
    // §4.1. Without it the launcher waits 10s for a button that will never
    // appear, which is exactly what one shared 商談AI account in two meetings
    // would hit.
    const otherJoinMethods = page.getByRole("button", {
      name: /その他の参加方法|other ways to join|more ways to join/i,
    });
    const joinOnThisDevice = page.getByText(
      /^(このデバイスでも参加|このデバイスで参加|join (?:on )?this device too|join here too)$/i,
      { exact: true },
    );
    const joinOnThisDeviceButton = joinOnThisDevice
      .first()
      .locator("xpath=ancestor-or-self::button[1]");

    try {
      await Promise.any([
        joinButton.first().waitFor({ state: "visible", timeout: 10_000 }),
        otherJoinMethods.first().waitFor({ state: "visible", timeout: 10_000 }),
        joinOnThisDevice.first().waitFor({ state: "visible", timeout: 10_000 }),
      ]);
      await page.waitForTimeout(options.joinDelay * 1_000);
      if (await locatorIsVisible(joinButton)) {
        // The controller panel can overlap Meet's lower-right join button.
        await joinButton.first().click({ timeout: 5_000, force: true });
      } else if (await locatorIsVisible(joinOnThisDevice)) {
        await activateLocator(joinOnThisDeviceButton, { method: "dom", timeout: 5_000 });
      } else {
        // Join as a second device so the participant keeps its own audio path.
        // Companion mode does not provide one, which would leave the agent in
        // the call but unable to hear or speak.
        await otherJoinMethods.first().click({ timeout: 5_000, force: true });
        await joinOnThisDevice.first().waitFor({ state: "visible", timeout: 5_000 });
        await activateLocator(joinOnThisDeviceButton, { method: "dom", timeout: 5_000 });
      }

      await page
        .waitForFunction(
          () => {
            const text = document.body?.innerText || "";
            return (
              /参加を許可するまで|waiting for the host|asking to join/i.test(
                text,
              ) ||
              /参加できません|can't join|cannot join/i.test(text) ||
              /通話から退出|leave call/i.test(text)
            );
          },
          undefined,
          { timeout: 15_000 },
        )
        .catch(() => {});

      const bodyText = await page.locator("body").innerText();
      if (/参加できません|can't join|cannot join/i.test(bodyText)) {
        connection = "rejected";
      } else if (/通話から退出|leave call/i.test(bodyText)) {
        connection = "joined";
      } else if (
        /参加を許可するまで|waiting for the host|asking to join/i.test(bodyText)
      ) {
        connection = "waiting";
      } else {
        connection = "manual-action-required";
        actionRequired = "admission-status-check";
      }
    } catch (error) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/通話から退出|leave call/i.test(bodyText)) {
        connection = "joined";
      } else {
        throw new Error(`Could not request Meet admission: ${error.message}`);
      }
    }
  }
}

// Captions are the transcript source (AGENTS.md §6). Switched on here so that
// nobody has to remember to, and only once actually in the call — the control
// does not exist on the pre-join screen. Best-effort: a meeting without a
// transcript is still a meeting, so failures are reported, never thrown.
let captions = { enabled: false, alreadyOn: false, collector: "not-installed" };
if (connection === "joined") {
  try {
    captions = { ...(await enableCaptions(page, locatorIsVisible)), collector: "not-installed" };
    captions.collector = await installCaptionCollector(page);
  } catch (error) {
    captions.error = error.message;
  }
}

// Chat is the in-meeting control surface and the transcription-free way to ask
// a question (AGENTS.md §5.2). The panel has to be *open* or Meet renders no
// messages into the DOM at all, so the collector would poll an empty page.
// Best-effort for the same reason as captions: no chat is a degraded meeting,
// not a failed one. `meeting-session.mjs` drains what this installs.
let chat = { open: false, alreadyOpen: false, collector: "not-installed" };
if (connection === "joined") {
  try {
    chat = { ...(await openChatPanel(page, locatorIsVisible)), collector: "not-installed" };
    chat.collector = await installChatCollector(page);
  } catch (error) {
    chat.error = error.message;
  }
}

const legacyJoinStatus = actionRequired === "camera-check"
  ? "manual-camera-check-required"
  : actionRequired === "google-login"
    ? "anonymous-login-required"
    : actionRequired === "admission-status-check"
      ? "requested-status-unknown"
      : connection === "waiting"
        ? "waiting-for-admission"
        : connection === "prejoin"
          ? "not-requested"
          : connection;
const result = createPreparationResult({
  providerId: "google-meet",
  meetingUrl: page.url(),
  connection,
  microphone: microphoneState === "off" ? "muted" : "unavailable",
  camera:
    cameraState === "off"
      ? "off"
      : cameraState === "unavailable"
        ? "unavailable"
        : "unknown",
  // Compatibility fields retained for direct users of the published script.
  url: page.url(),
  permission: "microphone granted for meet.google.com",
  microphoneOnboarding: usedMicrophone ? "dismissed" : "not shown",
  participantNameFilled: nameFilled,
  microphoneMuted: microphoneState === "off",
  cameraDisabled: cameraState === "off" || cameraState === "unavailable",
  cameraState,
  microphoneDevice: resolvedMicrophoneDevice,
  speakerDevice: resolvedSpeakerDevice,
  actionRequired,
  joinStatus: legacyJoinStatus,
  captions,
  chat,
  title: await page.title(),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (actionRequired === "google-login") {
  process.exit(PREPARATION_EXIT_CODES.loginRequired);
}
if (connection === "rejected") {
  process.exit(PREPARATION_EXIT_CODES.rejected);
}
if (actionRequired === "admission-status-check") {
  process.exit(PREPARATION_EXIT_CODES.stateUnknown);
}
if (actionRequired === "camera-check") {
  process.exit(PREPARATION_EXIT_CODES.manualActionRequired);
}
process.exit(0);
