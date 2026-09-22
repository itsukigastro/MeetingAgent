#!/usr/bin/env node

/**
 * The caption collector, exercised in a real Chrome against a synthetic Meet
 * caption region.
 *
 * A synthetic DOM cannot prove the selectors match *today's* Meet — only a live
 * meeting can, and that is a manual check. What it does prove is the part that
 * has no other way to be verified: that a line growing word by word is recorded
 * once and in full, that a reused slot does not swallow the previous utterance,
 * and that speaker names survive.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

import {
  collectorSource,
  drainMeetCaptions,
  CAPTION_REGION_SELECTORS,
  CAPTION_ON_LABEL,
  CAPTION_OFF_LABEL,
} from "../src/providers/google-meet/meet-captions.mjs";

// Cheap checks first: the label patterns are what `enableCaptions` clicks, and a
// typo there fails silently in a live meeting (no captions, no error).
assert.match("字幕をオンにする", CAPTION_ON_LABEL);
assert.match("Turn on captions", CAPTION_ON_LABEL);
assert.match("字幕をオフにする", CAPTION_OFF_LABEL);
assert.match("Turn off captions", CAPTION_OFF_LABEL);
assert.doesNotMatch("字幕をオフにする", CAPTION_ON_LABEL, "on/off labels must not overlap");
assert.ok(CAPTION_REGION_SELECTORS.length > 1, "keep a fallback selector for Meet redesigns");

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

try {
  const page = await browser.newPage();
  // Mirrors Meet's shape: a labelled live region, one block per speaker, the
  // name on its own line above the words.
  await page.setContent(`<!doctype html><html><body>
    <div role="region" aria-label="字幕" aria-live="polite" id="captions"></div>
  </body></html>`);

  const installed = await page.evaluate(collectorSource({ settleMs: 300 }));
  assert.equal(installed, "installed");
  assert.equal(
    await page.evaluate(collectorSource({ settleMs: 300 })),
    "already-installed",
    "installing twice must not start a second polling loop",
  );

  const setCaptions = (blocks) =>
    page.evaluate((html) => {
      document.querySelector("#captions").innerHTML = html;
    }, blocks.map((b) => `<div><div>${b.speaker}</div><div>${b.text}</div></div>`).join(""));

  const drain = () =>
    page.evaluate(() => {
      const state = globalThis.__meetronCaptions;
      const entries = state.entries.splice(0, state.entries.length);
      return { entries, region: state.region };
    });

  // A line Meet extends word by word must land once, complete.
  await setCaptions([{ speaker: "田中", text: "楽天の" }]);
  await page.waitForTimeout(700);
  await setCaptions([{ speaker: "田中", text: "楽天の手数料は" }]);
  await page.waitForTimeout(700);
  await setCaptions([{ speaker: "田中", text: "楽天の手数料はいくらですか" }]);

  // Settled: the growing line is finished and flushed.
  await page.waitForTimeout(1_200);
  const first = await drain();
  assert.equal(first.region, '[role="region"][aria-label*="字幕"]', "matched the ARIA selector");
  assert.deepEqual(
    first.entries.map((e) => ({ speaker: e.speaker, text: e.text })),
    [{ speaker: "田中", text: "楽天の手数料はいくらですか" }],
    "a line extended in place must be recorded once, in full",
  );
  assert.ok(Date.parse(first.entries[0].at) > 0, "entries carry a parseable timestamp");

  // A different utterance reusing the same slot must not overwrite the previous
  // one — that is how a whole turn goes missing from a summary.
  await setCaptions([{ speaker: "田中", text: "楽天の手数料はいくらですか" }]);
  await page.waitForTimeout(400);
  await setCaptions([{ speaker: "Son", text: "確認します" }]);
  await page.waitForTimeout(1_200);
  const second = await drain();
  assert.deepEqual(
    second.entries.map((e) => `${e.speaker}: ${e.text}`),
    ["Son: 確認します"],
    "a new speaker in the same slot is its own entry",
  );

  // Two speakers on screen at once, which is the normal steady state.
  await setCaptions([
    { speaker: "田中", text: "では来週で" },
    { speaker: "Son", text: "承知しました" },
  ]);
  await page.waitForTimeout(1_200);
  const third = await drain();
  assert.deepEqual(
    third.entries.map((e) => `${e.speaker}: ${e.text}`).sort(),
    ["Son: 承知しました", "田中: では来週で"],
    "concurrent speakers are kept apart",
  );

  // Captions off: the region empties. Nothing should be invented, and the
  // collector must survive to pick up again when they come back.
  await page.evaluate(() => {
    document.querySelector("#captions").innerHTML = "";
  });
  await page.waitForTimeout(800);
  assert.deepEqual((await drain()).entries, [], "an empty region produces no entries");

  await setCaptions([{ speaker: "田中", text: "戻りました" }]);
  await page.waitForTimeout(1_200);
  assert.deepEqual(
    (await drain()).entries.map((e) => e.text),
    ["戻りました"],
    "the collector keeps running after captions are toggled off and on",
  );
  // Teardown must include the caption that has not aged through settleMs.
  await setCaptions([{ speaker: "田中", text: "最後の次のアクションです" }]);
  const final = await drainMeetCaptions(page, { final: true });
  assert.deepEqual(final.entries.map(e => e.text), ["最後の次のアクションです"]);
  assert.equal(final.pending, 0);
  assert.deepEqual((await drainMeetCaptions(page, { final: true })).entries, []);
} finally {
  await browser.close();
}

process.stdout.write("Meet caption collector records growing lines once, with speakers.\n");
