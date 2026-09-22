import { createRuntimeProvider } from "../provider-contract.mjs";
import { MeetronError } from "../../core/errors.mjs";
import {
  activateLocator,
  allBrowserPages,
  firstVisibleLocator,
  safePageUrl,
  waitForValue,
} from "../../browser/meeting-browser.mjs";
import { getPlatformAdapter } from "../../platform/platform-registry.mjs";

const MEETING_PATH = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;

/**
 * Meet's post-call screen — the wording it shows once the participant is out of
 * the call, whether it hung up, was removed, or the host ended the call for
 * everyone.
 *
 * Matched only after 「通話から退出」 has been ruled out, so a live call can never
 * be read as ended: while in the call the leave button is present and wins.
 * Without this the post-call screen fell through to "prejoin", and nothing
 * downstream could tell "about to join" from "the meeting is over".
 */
export const POST_CALL_TEXT =
  /通話から退出しました|会議から退出しました|この通話は終了しました|通話が終了しました|ミーティングは終了しました|you(?:'| ha)?ve left the (?:meeting|call)|your (?:meeting|call) has ended|the (?:meeting|call) has ended|call ended|会議から削除されました|通話から削除されました|you(?: were| have been|’ve been|\'ve been) removed from (?:the|this) (?:meeting|call)/i;

export function normalizeGoogleMeetUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new MeetronError("INVALID_MEETING_URL", "有効なGoogle Meet URLを入力してください");
  }

  const match = url.pathname.match(MEETING_PATH);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "meet.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new MeetronError(
      "UNSUPPORTED_MEETING_URL",
      "https://meet.google.com/xxx-xxxx-xxx 形式のURLを入力してください",
    );
  }
  url.pathname = `/${match[1].toLowerCase()}`;
  url.search = "";
  url.hash = "";
  return {
    providerId: "google-meet",
    url: url.toString(),
    displayUrl: `https://meet.google.com/${match[1].toLowerCase()}`,
    meetingKey: match[1].toLowerCase(),
  };
}

export const googleMeetDefinition = Object.freeze({
  id: "google-meet",
  label: "Google Meet",
  automation: Object.freeze({
    initialPage: "meeting-display-url",
    preparationScript: "prepare-meet.mjs",
    urlTransport: "argument",
    supportsJoinDelay: true,
  }),
  capabilities: Object.freeze({
    audioSelection: "provider-ui",
    camera: "required-off",
    postJoinMicrophone: "unmuted",
    waitingRoom: true,
  }),
  matchUrl(value) {
    try {
      normalizeGoogleMeetUrl(value);
      return true;
    } catch {
      return false;
    }
  },
  normalizeUrl: normalizeGoogleMeetUrl,
});

export function findGoogleMeetPage(browser) {
  return allBrowserPages(browser)
    .find((candidate) => candidate.url().startsWith("https://meet.google.com/"));
}

function googleMeetMicrophoneControls(page) {
  return {
    turnOn: [
      page.getByRole("button", {
        name: /マイクをオン(?:にする)?|turn on microphone|unmute microphone/i,
      }),
      page.locator(
        '[aria-label*="マイクをオン"], [aria-label*="turn on microphone" i], [aria-label*="unmute microphone" i]',
      ),
      page.locator(
        '[data-tooltip*="マイクをオン"], [data-tooltip*="turn on microphone" i], [data-tooltip*="unmute microphone" i]',
      ),
    ],
    turnOff: [
      page.getByRole("button", {
        name: /マイクをオフ(?:にする)?|turn off microphone|mute microphone/i,
      }),
      page.locator(
        '[aria-label*="マイクをオフ"], [aria-label*="turn off microphone" i], [aria-label*="mute microphone" i]',
      ),
      page.locator(
        '[data-tooltip*="マイクをオフ"], [data-tooltip*="turn off microphone" i], [data-tooltip*="mute microphone" i]',
      ),
    ],
  };
}

export async function getGoogleMeetMicrophoneState(page) {
  const stateControls = page.locator("[data-is-muted]");
  try {
    const count = await stateControls.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = stateControls.nth(index);
      if (!(await candidate.isVisible())) continue;
      const value = await candidate.getAttribute("data-is-muted");
      if (value === "true") return "muted";
      if (value === "false") return "unmuted";
    }
  } catch {
    // Fall back to localized labels when Meet does not expose data-is-muted.
  }
  const { turnOn, turnOff } = googleMeetMicrophoneControls(page);
  if (await firstVisibleLocator(turnOn)) return "muted";
  if (await firstVisibleLocator(turnOff)) return "unmuted";
  return "unavailable";
}

async function waitForGoogleMeetMicrophoneState(page, expected, timeout = 500) {
  return waitForValue(
    () => getGoogleMeetMicrophoneState(page),
    expected,
    { timeout, interval: 50 },
  );
}

async function pressGoogleMeetMicrophoneShortcut(page) {
  await page.keyboard.press(getPlatformAdapter().meetingMuteShortcut);
  await page.waitForTimeout(300);
}

export async function setGoogleMeetMicrophone(
  browser,
  _locatorIsVisible,
  state,
  { assumeBefore = "", trackedBefore = "", waitMs = 0 } = {},
) {
  if (!["muted", "unmuted", "toggle"].includes(state)) {
    throw new MeetronError("INVALID_MICROPHONE_STATE", "Unsupported Google Meet microphone state");
  }
  const page = findGoogleMeetPage(browser);
  if (!page) throw new MeetronError("MEETING_NOT_RUNNING", "Google Meet participant was not found");
  page.setDefaultTimeout(5_000);

  let before = await getGoogleMeetMicrophoneState(page);
  if (before === "unavailable" && waitMs > 0) {
    await page.waitForFunction(
      () => /通話から退出|leave call|参加できません|can't join|cannot join/i.test(
        document.body?.innerText || "",
      ),
      undefined,
      { timeout: waitMs },
    ).catch(() => {});
    before = await getGoogleMeetMicrophoneState(page);
  }

  const effectiveBefore = before === "unavailable" ? assumeBefore || trackedBefore : before;
  if (before === "unavailable" && !effectiveBefore && state !== "toggle") {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/参加できません|can't join|cannot join/i.test(bodyText)) {
      throw new MeetronError("ADMISSION_REJECTED", "Google Meet rejected this participant");
    }
    throw new MeetronError(
      "MICROPHONE_STATE_UNKNOWN",
      "The Meet microphone is unavailable or admission timed out",
    );
  }

  const desired = state === "toggle"
    ? effectiveBefore === "muted"
      ? "unmuted"
      : effectiveBefore === "unmuted"
        ? "muted"
        : "toggled"
    : state;
  let usedKeyboardShortcut = false;
  let interaction = "none";

  if (before === "unavailable") {
    if (desired !== effectiveBefore) {
      await pressGoogleMeetMicrophoneShortcut(page);
      usedKeyboardShortcut = true;
      interaction = "keyboard";
    }
  } else if (before !== desired) {
    const { turnOn, turnOff } = googleMeetMicrophoneControls(page);
    const controls = desired === "unmuted" ? turnOn : turnOff;
    let control = await firstVisibleLocator(controls);
    if (control) {
      try {
        interaction = await activateLocator(control, { timeout: 1_500 });
      } catch {
        // Meet may replace the control while it is being clicked.
      }
      if ((await waitForGoogleMeetMicrophoneState(page, desired, 300)) !== desired) {
        control = await firstVisibleLocator(controls);
        if (control) {
          try {
            interaction = await activateLocator(control, { method: "dom", timeout: 1_500 });
          } catch {
            // The keyboard shortcut below is Meet's final provider-specific fallback.
          }
        }
      }
      if ((await waitForGoogleMeetMicrophoneState(page, desired, 300)) !== desired) {
        await pressGoogleMeetMicrophoneShortcut(page);
        usedKeyboardShortcut = true;
        interaction = "keyboard";
      }
    } else {
      await pressGoogleMeetMicrophoneShortcut(page);
      usedKeyboardShortcut = true;
      interaction = "keyboard";
    }
  }

  const detectedAfter = desired === "toggled"
    ? await getGoogleMeetMicrophoneState(page)
    : await waitForValue(
      () => getGoogleMeetMicrophoneState(page),
      desired,
      { timeout: 2_000, interval: 100 },
    );
  const verified = desired !== "toggled" && detectedAfter === desired;
  if (!verified) {
    throw new MeetronError(
      "MICROPHONE_STATE_UNKNOWN",
      `Meet microphone did not change to ${desired}`,
    );
  }
  return {
    status: "ok",
    url: safePageUrl(page),
    before,
    after: detectedAfter,
    detectedAfter,
    verified,
    usedKeyboardShortcut,
    interaction,
  };
}

export async function getGoogleMeetStatus(browser, locatorIsVisible, page = findGoogleMeetPage(browser)) {
  if (!page) {
    return {
      browserConnected: true,
      connection: "not-running",
      microphone: "unavailable",
      camera: "unknown",
      audioConnection: "unknown",
    };
  }

  const leave = page.locator('button[aria-label*="通話から退出"], [role="button"][aria-label*="通話から退出"], button[aria-label*="leave call" i], [role="button"][aria-label*="leave call" i]');
  const [microphone, leaveVisible, bodyText] = await Promise.all([
    getGoogleMeetMicrophoneState(page),
    locatorIsVisible(leave),
    page.locator("body").innerText().catch(() => ""),
  ]);

  let connection = "prejoin";
  if (leaveVisible) {
    connection = "joined";
  } else if (/参加を許可するまで|waiting for the host|asking to join/i.test(bodyText)) {
    connection = "waiting";
  } else if (/参加できません|can't join|cannot join/i.test(bodyText)) {
    connection = "rejected";
  } else if (POST_CALL_TEXT.test(bodyText)) {
    connection = "ended";
  }

  return {
    browserConnected: true,
    connection,
    microphone,
    camera: "unknown",
    audioConnection:
      connection === "joined" && microphone !== "unavailable" ? "connected" : "unknown",
    url: safePageUrl(page),
    title: await page.title(),
  };
}

/**
 * How many people are in the call, or null when it cannot be told.
 *
 * Used for one decision only: the AI is alone, so the meeting is over. Null is
 * a first-class answer — every selector here is Meet's obfuscated markup, and
 * a wrong count would end a live meeting. The caller treats null as "no
 * signal", so the worst case of a broken selector is that the AI stays until
 * one of the other end signals fires.
 */
export async function countGoogleMeetParticipants(page) {
  if (!page || page.isClosed()) return null;
  return page
    .evaluate(() => {
      // Grid tiles are virtualized and may show only one of many attendees.
      // Only trust Meet's explicit total, never the number of rendered tiles.
      const labels = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')]
        .map((node) => node.getAttribute("aria-label") || "");
      for (const label of labels) {
        if (!/参加者|people|participants/i.test(label)) continue;
        const digits = label.match(/\d+/)?.[0];
        if (digits && Number(digits) > 0) return Number(digits);
      }
      return null;
    })
    .catch(() => null);
}

export async function reconcileGoogleMeetSession(
  _browser,
  _locatorIsVisible,
  { status } = {},
) {
  return {
    ready:
      status?.connection !== "joined" ||
      new Set(["muted", "unmuted"]).has(status?.microphone),
    changed: false,
  };
}

export async function leaveGoogleMeet(browser, locatorIsVisible, page = findGoogleMeetPage(browser)) {
  if (!page || page.isClosed()) {
    return { left: false, alreadyLeft: true, tabClosed: true };
  }

  const leave = page.getByRole("button", { name: /通話から退出|leave call/i });
  const leaveVisible = await locatorIsVisible(leave);
  if (leaveVisible) {
    await activateLocator(leave, { method: "force", timeout: 5_000 });
    await page.waitForTimeout(300);
  }
  if (!page.isClosed()) {
    await page.close({ runBeforeUnload: false });
  }
  return { left: leaveVisible, alreadyLeft: !leaveVisible, tabClosed: true };
}

export const googleMeetRuntimeProvider = createRuntimeProvider(googleMeetDefinition, {
  getStatus: getGoogleMeetStatus,
  reconcileSession: reconcileGoogleMeetSession,
  setMicrophone: setGoogleMeetMicrophone,
  leave: leaveGoogleMeet,
});
