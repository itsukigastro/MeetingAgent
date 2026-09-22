/**
 * The Gastrobrain meetings API, as called from inside a meeting.
 *
 * The contract is `../gastro/docs/MEETINGS_WEB.md` §6: five calls, authenticated
 * with a service token in `X-Meeting-Agent-Token`, because the participant is a
 * machine and has no Supabase user JWT.
 *
 * Deliberately a thin, injectable module rather than calls scattered through
 * the supervisor:
 *
 * - `fetchImpl` and `sleep` are parameters, so the whole retry and redaction
 *   behaviour is testable without a network or a running backend.
 * - Every method throws {@link MeetingApiError} with a `status`, so the
 *   supervisor can decide per call site what is fatal (the initial upsert) and
 *   what is best-effort (everything during the meeting). Nothing here decides
 *   that on its own — losing the transcript must never take the AI out of the
 *   call.
 *
 * ⚠️ The token is a shared secret with write access to every meeting. It lives
 * in this process only: it is never passed on a command line (visible in `ps`),
 * never handed to the browser, and scrubbed out of anything this module throws.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 250;

/** Transient by nature: worth another attempt. A 4xx is not. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class MeetingApiError extends Error {
  constructor(message, { status = 0, path = "", attempts = 1 } = {}) {
    super(message);
    this.name = "MeetingApiError";
    this.status = status;
    this.path = path;
    this.attempts = attempts;
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Localhost over http is allowed so the supervisor can be pointed at a local
 * FastAPI; everything else must be https, because the token is a bearer
 * credential and this process may well be running on a VPS.
 */
function assertUsableBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MeetingApiError("GASTROBRAIN_API_URL is not a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new MeetingApiError(
      "GASTROBRAIN_API_URL must be https (or http on localhost)",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MeetingApiError("GASTROBRAIN_API_URL must not contain credentials, query, or fragment");
  }
  return url;
}

export function createMeetingClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  sleep = sleepMs,
  log = () => {},
} = {}) {
  if (!baseUrl) throw new MeetingApiError("GASTROBRAIN_API_URL is not set");
  if (!token) throw new MeetingApiError("MEETING_AGENT_TOKEN is not set");
  assertUsableBaseUrl(baseUrl);

  const root = baseUrl.replace(/\/+$/, "");
  /** Belt and braces: the token should never reach a log line or an exception. */
  const redact = (text) => String(text ?? "").split(token).join("[REDACTED]");

  async function request(method, path, body) {
    const url = `${root}/v1${path}`;
    let lastError;

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method,
          redirect: "error",
          headers: {
            "X-Meeting-Agent-Token": token,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }

        // Read the body for the message, but keep it short: FastAPI validation
        // errors are long and the useful part is at the front.
        const detail = redact(await response.text().catch(() => "")).slice(0, 300);
        lastError = new MeetingApiError(
          `${method} ${path} → HTTP ${response.status} ${detail}`,
          { status: response.status, path, attempts: attempt },
        );
        if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
      } catch (error) {
        if (error instanceof MeetingApiError && !RETRYABLE_STATUS.has(error.status)) throw error;
        lastError =
          error instanceof MeetingApiError
            ? error
            : new MeetingApiError(`${method} ${path} → ${redact(error.message)}`, {
                path,
                attempts: attempt,
              });
      }

      if (attempt <= retries) {
        const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
        log(`[api] retry ${attempt}/${retries} in ${backoff}ms: ${lastError.message}`);
        await sleep(backoff);
      }
    }

    lastError.attempts = retries + 1;
    throw lastError;
  }

  return {
    /**
     * Register the meeting, or find the existing row. Idempotent on
     * `google_event_id`, so the supervisor calls it on every start — including
     * a restart into a meeting that is already running.
     *
     * `attendees` is the access-control list (§5) and is fail-closed: a meeting
     * posted without it is readable by nobody, which the supervisor refuses to
     * do rather than silently creating an unreadable meeting.
     */
    upsert({ googleEventId, title = null, meetUrl = null, scheduledAt, attendees = [] }) {
      return request("POST", "/meetings", {
        google_event_id: googleEventId,
        title,
        meet_url: meetUrl,
        scheduled_at: scheduledAt,
        attendees: attendees.map(({ email, isOrganizer = false }) => ({
          email,
          is_organizer: isOrganizer,
        })),
      });
    },

    /** Agent-writable fields only: status, started_at, agent_state (§6.2). */
    patch(meetingId, { status, startedAt, agentState } = {}) {
      const body = {};
      if (status !== undefined) body.status = status;
      if (startedAt !== undefined) body.started_at = startedAt;
      if (agentState !== undefined) body.agent_state = agentState;
      return request("PATCH", `/meetings/${meetingId}`, body);
    },

    /** Caption lines. Idempotent on (meeting_id, seq); resending is safe. */
    postSegments(meetingId, segments) {
      return request("POST", `/meetings/${meetingId}/segments`, { segments });
    },

    /** The AI is leaving. Summary generation starts here, so post segments first. */
    end(meetingId, endedAt) {
      return request("POST", `/meetings/${meetingId}/end`, { ended_at: endedAt });
    },

    /** The only control channel: the web UI writes, the participant polls (§6.3). */
    getState(meetingId) {
      return request("GET", `/meetings/${meetingId}/state`);
    },
  };
}
