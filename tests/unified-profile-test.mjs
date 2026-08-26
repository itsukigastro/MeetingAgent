#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectToChromeOverCDP } from "../scripts/playwright-cdp.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-unified-profile-"));

const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const allocated = server.address().port;
    server.close(() => resolvePort(allocated));
  });
});

const chrome = spawn(
  executablePath,
  [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let browser;
try {
  let endpointReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    endpointReady = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (endpointReady) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!endpointReady) {
    throw new Error("Chrome CDP endpoint did not start.");
  }

  const { stdout: ownershipOutput } = await execFileAsync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/verify-dedicated-chrome.mjs"),
      "--profile-dir",
      profileDir,
      "--port",
      String(port),
    ],
    { cwd: repoRoot, timeout: 10_000 },
  );
  if (JSON.parse(ownershipOutput).verified !== true) {
    throw new Error(`Dedicated Chrome ownership was not verified: ${ownershipOutput}`);
  }
  let wrongProfileRejected = false;
  try {
    await execFileAsync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/verify-dedicated-chrome.mjs"),
        "--profile-dir",
        resolve(profileDir, "not-the-active-profile"),
        "--port",
        String(port),
      ],
      { cwd: repoRoot, timeout: 10_000 },
    );
  } catch {
    wrongProfileRejected = true;
  }
  if (!wrongProfileRejected) {
    throw new Error("A CDP endpoint from another profile was accepted.");
  }

  browser = await connectToChromeOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  const { stdout: internalPageOutput } = await execFileAsync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/open-chrome-page.mjs"),
      "--cdp",
      `http://127.0.0.1:${port}`,
      "--url",
      "chrome://version/",
    ],
    { cwd: repoRoot, timeout: 10_000 },
  );
  const internalPageResult = JSON.parse(internalPageOutput);
  if (!internalPageResult.opened || internalPageResult.url !== "chrome://version/") {
    throw new Error(`Chrome internal page did not open: ${internalPageOutput}`);
  }

  // Stand in for the deployed Gastrobrain agent. The real page connects to the
  // Realtime API on load and then publishes `data-meeting-status`; here the
  // attribute is set directly, because what this test covers is the launcher's
  // half of that contract — tab replacement, and the three states it acts on.
  const agentOrigin = "https://agent.example.test";
  const agentUrl = `${agentOrigin}/voice?mode=meeting`;
  await context.route(`${agentOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/login")) {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Sign in</title>" });
    }
    // /voice-fails simulates the page failing to reach the Realtime API.
    const state = path.startsWith("/voice-fails") ? "error" : "listening";
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><script>
        document.documentElement.dataset.meetingStatus = ${JSON.stringify(state)};
      </script></body></html>`,
    });
  });
  await context.route("https://meet.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Meet preserved</title>" }),
  );

  const meetPage = await context.newPage();
  await meetPage.goto("https://meet.google.com/abc-defg-hij");
  const staleAgentPage = await context.newPage();
  await staleAgentPage.goto(`${agentOrigin}/voice?mode=meeting&stale=1`);

  const runPrepare = (url, extraArgs = []) =>
    execFileAsync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/prepare-agent.mjs"),
        "--cdp",
        `http://127.0.0.1:${port}`,
        "--agent-url",
        url,
        "--timeout",
        "15000",
        ...extraArgs,
      ],
      { cwd: repoRoot, timeout: 30_000 },
    );

  const { stdout } = await runPrepare(agentUrl, ["--replace-tab"]);
  const pages = context.pages();
  const agentPages = pages.filter((page) => page.url().startsWith(agentOrigin));

  if (
    !/listening/.test(stdout) ||
    !staleAgentPage.isClosed() ||
    meetPage.isClosed() ||
    agentPages.length !== 1
  ) {
    throw new Error(
      `Agent tab replacement did not preserve Meet: ${JSON.stringify({
        stdout,
        staleClosed: staleAgentPage.isClosed(),
        meetClosed: meetPage.isClosed(),
        agentPages: agentPages.length,
      })}`,
    );
  }

  // A page that cannot start must fail loudly. Silent failure here is the worst
  // case: Meetron reports success and the agent sits mute through the 商談.
  let startFailureDetected = false;
  try {
    await runPrepare(`${agentOrigin}/voice-fails?mode=meeting`, ["--replace-tab"]);
  } catch (error) {
    startFailureDetected = /failed to start/i.test(error.stderr || error.message);
  }

  // Not signed in is its own exit code, so the launcher can say "log in once"
  // rather than reporting a generic timeout.
  let loginExitCode = null;
  try {
    await runPrepare(`${agentOrigin}/login?mode=meeting`);
  } catch (error) {
    loginExitCode = error.code;
  }

  if (!startFailureDetected || loginExitCode !== 10 || meetPage.isClosed()) {
    throw new Error(
      `Agent failure handling is wrong: ${JSON.stringify({
        startFailureDetected,
        loginExitCode,
        meetClosed: meetPage.isClosed(),
      })}`,
    );
  }
} finally {
  await browser?.close().catch(() => {});
  chrome.kill();
  if (chrome.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ]);
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write("Unified profile replaces only the agent tab and reports agent failures.\n");
