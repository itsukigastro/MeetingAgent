#!/usr/bin/env node

/**
 * The chat collector, exercised in a real Chrome against a synthetic Meet chat
 * panel.
 *
 * A synthetic DOM cannot prove the selectors match *today's* Meet — only a live
 * meeting can, and that is a manual check. What it does prove is the behaviour
 * that has no other way to be verified: that history present on join is not
 * replayed as fresh commands, that each new message is delivered exactly once,
 * that grouped messages from one sender are kept apart, and that timestamps are
 * not mistaken for message bodies.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

import {
  collectorSource,
  CHAT_REGION_SELECTORS,
  CHAT_OPEN_LABEL,
  CHAT_CLOSE_LABEL,
} from "../src/providers/google-meet/meet-chat.mjs";

// Cheap checks first: the label patterns are what `openChatPanel` clicks, and a
// typo there fails silently in a live meeting (no chat panel, no error).
assert.match("全員とチャット", CHAT_OPEN_LABEL);
assert.match("Chat with everyone", CHAT_OPEN_LABEL);
assert.match("チャットを閉じる", CHAT_CLOSE_LABEL);
assert.match("Close chat", CHAT_CLOSE_LABEL);
assert.ok(CHAT_REGION_SELECTORS.length > 1, "keep a fallback selector for Meet redesigns");

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

try {
  const page = await browser.newPage();
  // Mirrors Meet's shape: a labelled region, one block per message group, the
  // sender and a timestamp on their own lines above the words.
  await page.setContent(`<!doctype html><html><body>
    <div role="region" aria-label="チャット" id="chat"></div>
  </body></html>`);

  const setChat = (blocks) =>
    page.evaluate((html) => {
      document.querySelector("#chat").innerHTML = html;
    }, blocks
      .map(
        (b) =>
          `<div><div>${b.sender}</div><div>${b.at ?? "午後1:23"}</div>` +
          b.lines.map((l) => `<div>${l}</div>`).join("") +
          `</div>`,
      )
      .join(""));

  const drain = () =>
    page.evaluate(() => {
      const state = globalThis.__meetronChat;
      const messages = state.messages.splice(0, state.messages.length);
      return { messages, region: state.region };
    });

  // History is already on screen when the agent joins.
  await setChat([{ sender: "田中", lines: ["商談AI 静かに", "おつかれさまです"] }]);

  const installed = await page.evaluate(collectorSource({ pollMs: 100 }));
  assert.equal(installed, "installed");
  assert.equal(
    await page.evaluate(collectorSource({ pollMs: 100 })),
    "already-installed",
    "installing twice must not start a second polling loop",
  );

  await page.waitForTimeout(300);
  const primed = await drain();
  assert.equal(primed.region, '[role="region"][aria-label*="チャット"]', "matched the ARIA selector");
  assert.deepEqual(
    primed.messages,
    [],
    "chat present before the agent joined must not be replayed as commands",
  );

  // A new message arrives.
  await setChat([
    { sender: "田中", lines: ["商談AI 静かに", "おつかれさまです"] },
    { sender: "Son", lines: ["商談AI 楽天のSKU上限は？"] },
  ]);
  await page.waitForTimeout(300);
  const first = await drain();
  assert.deepEqual(
    first.messages.map((m) => `${m.sender}: ${m.text}`),
    ["Son: 商談AI 楽天のSKU上限は？"],
    "only the new message is delivered",
  );
  assert.ok(Date.parse(first.messages[0].at) > 0, "messages carry a parseable timestamp");

  // Polling again must not re-deliver what has already been handled — a command
  // repeated every 500 ms would toggle the agent forever.
  await page.waitForTimeout(300);
  assert.deepEqual((await drain()).messages, [], "a message is delivered exactly once");

  // Meet groups consecutive messages from one sender into a single block.
  await setChat([
    { sender: "田中", lines: ["商談AI 静かに", "おつかれさまです"] },
    { sender: "Son", lines: ["商談AI 楽天のSKU上限は？", "あと手数料も", "商談AI 静かに"] },
  ]);
  await page.waitForTimeout(300);
  const grouped = await drain();
  assert.deepEqual(
    grouped.messages.map((m) => m.text),
    ["あと手数料も", "商談AI 静かに"],
    "each line in a grouped block is its own message, and the first is not re-sent",
  );
  assert.ok(
    grouped.messages.every((m) => m.sender === "Son"),
    "the sender carries across a grouped block",
  );

  // Two people can legitimately send the same words.
  await setChat([
    { sender: "田中", lines: ["商談AI 静かに", "おつかれさまです"] },
    { sender: "Son", lines: ["商談AI 楽天のSKU上限は？", "あと手数料も", "商談AI 静かに"] },
    { sender: "佐藤", lines: ["おつかれさまです"] },
  ]);
  await page.waitForTimeout(300);
  assert.deepEqual(
    (await drain()).messages.map((m) => `${m.sender}: ${m.text}`),
    ["佐藤: おつかれさまです"],
    "identical text from a different sender is its own message",
  );

  // The panel is closed and reopened: the region is rebuilt, and the collector
  // must survive it without replaying everything.
  await page.evaluate(() => {
    document.querySelector("#chat").innerHTML = "";
  });
  await page.waitForTimeout(300);
  assert.deepEqual((await drain()).messages, [], "an empty panel produces no messages");

  await setChat([
    { sender: "田中", lines: ["商談AI 静かに", "おつかれさまです"] },
    { sender: "Son", lines: ["商談AI 楽天のSKU上限は？", "あと手数料も", "商談AI 静かに"] },
    { sender: "佐藤", lines: ["おつかれさまです"] },
    { sender: "佐藤", lines: ["商談AI 起きて"] },
  ]);
  await page.waitForTimeout(300);
  assert.deepEqual(
    (await drain()).messages.map((m) => m.text),
    ["商談AI 起きて"],
    "reopening the panel replays nothing and picks up the new message",
  );
} finally {
  await browser.close();
}

process.stdout.write("Meet chat collector delivers new messages once, without replaying history.\n");
