#!/usr/bin/env node

/**
 * The chat collector against the markup Google Meet actually serves.
 *
 * `meet-chat-test.mjs` builds a block per message group with the sender, the
 * time and the body on separate lines, and the collector's structural walk
 * reads that correctly. Real Meet does not look like that. Captured live on
 * 2026-09-21 from `div[jsname="xySENc"]`:
 *
 *   div[jsname="Ypafjf"]                 group
 *     div.poVWob                         孫イツキ
 *     div[jsname="biJjHb"]               10:37 AM
 *     div[data-message-id="spaces/…"]    商談AI 起きて
 *
 * and the group's innerText came back as one run with no newlines at all —
 * "孫イツキ10:37 AM商談AI 起きて". The walk therefore produced a single message
 * with an empty sender and the name and clock glued to the front, so the wake
 * word was no longer at position 0 and `parseChatCommand` failed closed. The
 * agent stayed asleep while the message sat in the queue.
 *
 * What this file pins down is the `data-message-id` path: body text alone,
 * sender recovered from the group, and exact deduplication by Meet's own id.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

import { collectorSource } from "../src/providers/google-meet/meet-chat.mjs";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

let messageCounter = 0;

try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div jsname="xySENc" id="chat"></div>
  </body></html>`);

  // One group per sender, mirroring the capture above. `display:inline` on the
  // parts is what makes innerText arrive without newlines, which is precisely
  // the condition the structural walk cannot survive.
  const setChat = (groups) =>
    page.evaluate(
      ({ html }) => {
        document.querySelector("#chat").innerHTML = html;
      },
      {
        html: groups
          .map(
            (g) =>
              `<div jsname="Ypafjf" style="display:inline">` +
              `<div class="poVWob" style="display:inline">${g.sender}</div>` +
              `<div jsname="biJjHb" style="display:inline">${g.at ?? "10:37 AM"}</div>` +
              g.messages
                .map(
                  (m) =>
                    `<div data-message-id="${m.id}" style="display:inline">` +
                    `<div jsname="dTKtvb" style="display:inline">${m.text}</div></div>`,
                )
                .join("") +
              `</div>`,
          )
          .join(""),
      },
    );

  const message = (text) => ({ id: `spaces/xg4AFEyxyQcB/messages/${++messageCounter}`, text });

  const drain = () =>
    page.evaluate(() => {
      const state = globalThis.__meetronChat;
      return { messages: state.messages.splice(0, state.messages.length), region: state.region };
    });

  // History already on screen when the agent joins.
  const history = message("おつかれさまです");
  await setChat([{ sender: "田中", messages: [history] }]);

  assert.equal(await page.evaluate(collectorSource({ pollMs: 100 })), "installed");
  await page.waitForTimeout(300);

  const primed = await drain();
  assert.equal(primed.region, 'div[jsname="xySENc"]');
  assert.deepEqual(primed.messages, [], "history present on join must not replay as commands");

  // The exact message that failed in the live meeting.
  const wake = message("商談AI 起きて");
  await setChat([
    { sender: "田中", messages: [history] },
    { sender: "孫イツキ", messages: [wake] },
  ]);
  await page.waitForTimeout(300);

  const first = await drain();
  assert.equal(first.messages.length, 1, "exactly one new message");
  assert.equal(
    first.messages[0].text,
    "商談AI 起きて",
    "the body must carry no sender and no timestamp — this is the live-meeting bug",
  );
  assert.equal(
    first.messages[0].text.indexOf("商談AI"),
    0,
    "the wake word must be at position 0, where parseChatCommand requires it",
  );
  assert.equal(first.messages[0].sender, "孫イツキ", "sender recovered from the group");

  // Polling again must not re-deliver; a command repeated every second would
  // toggle the agent forever.
  await page.waitForTimeout(300);
  assert.deepEqual((await drain()).messages, [], "a message is delivered exactly once");

  // Meet's id deduplicates exactly, so repeating yourself is two messages —
  // the structural path needed an index hack to manage this.
  const again = message("商談AI 起きて");
  await setChat([
    { sender: "田中", messages: [history] },
    { sender: "孫イツキ", messages: [wake, again] },
  ]);
  await page.waitForTimeout(300);
  assert.deepEqual(
    (await drain()).messages.map((m) => m.text),
    ["商談AI 起きて"],
    "the same words sent twice are two distinct messages, keyed by Meet's id",
  );
} finally {
  await browser.close();
}

process.stdout.write(
  "Meet chat collector reads data-message-id: body only, sender recovered, deduped by id.\n",
);
