#!/usr/bin/env bash

# Launch (or reuse) the dedicated Chrome and bring up the Gastrobrain voice
# agent in it. Replaces open-chatgpt-live.sh.
#
# Unlike the ChatGPT version there is no Project URL to configure: the agent has
# one address, defaulted below and overridable for local development. The only
# manual step left is signing in to Gastrobrain once per profile.

set -eu

dry_run=0
restart_profile=0
replace_tab=0
agent_url=''
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# The deployed agent. `mode=meeting` is what selects the Meetron loopback
# devices and the wake-word gate; without it the page answers every utterance.
default_agent_url='https://gastron-brain-web.vercel.app/voice?mode=meeting'

environment_agent_url="${MEETING_COPILOT_AGENT_URL:-}"
environment_cdp_port="${MEETING_COPILOT_CDP_PORT:-}"

if [ -f "$repo_root/.meeting-copilot.env" ]; then
  # shellcheck disable=SC1091
  . "$repo_root/.meeting-copilot.env"
fi

# A value from the real environment wins over the env file.
if [ -n "$environment_agent_url" ]; then
  MEETING_COPILOT_AGENT_URL="$environment_agent_url"
fi
if [ -n "$environment_cdp_port" ]; then
  MEETING_COPILOT_CDP_PORT="$environment_cdp_port"
fi

usage() {
  cat <<'EOF'
Usage: ./scripts/open-agent.sh [options]

Opens the Gastrobrain voice agent in the shared Meetron Chrome profile.

Environment variables:
  MEETING_COPILOT_AGENT_URL     Override the agent URL (must include mode=meeting).
  MEETING_COPILOT_PROFILE_DIR   Shared dedicated user data directory.
  MEETING_COPILOT_CDP_PORT      Shared local automation port (default: 9223).
  MEETING_COPILOT_CHROME_PATH   Override the Google Chrome .app path.

Options:
  --agent-url URL     Override the agent URL for this run.
  --restart-profile   Restart the whole shared profile before initial launch.
  --replace-tab       Replace only the agent tab and preserve an active meeting.
  --dry-run           Print the launch command without opening Chrome.
  -h, --help          Show this help.

The first run leaves the browser open for the Gastrobrain (Slack) sign-in. Sign
in once and run this command again.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-url)
      shift
      agent_url="${1:-}"
      ;;
    --restart-profile)
      restart_profile=1
      ;;
    --replace-tab)
      replace_tab=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$agent_url" ]; then
  agent_url="${MEETING_COPILOT_AGENT_URL:-$default_agent_url}"
fi

# http is accepted on localhost only, so `next dev` can be driven without a
# deploy; browsers treat localhost as a secure context, so getUserMedia works.
case "$agent_url" in
  https://*mode=meeting*) ;;
  http://localhost*mode=meeting*|http://127.0.0.1*mode=meeting*) ;;
  *)
    printf 'The agent URL must include mode=meeting and be https (or http on localhost): %s\n' "$agent_url" >&2
    exit 2
    ;;
esac

find_chrome() {
  for app_path in \
    '/Applications/Google Chrome.app' \
    "$HOME/Applications/Google Chrome.app"; do
    if [ -d "$app_path" ]; then
      printf '%s\n' "$app_path"
      return 0
    fi
  done
  return 1
}

chrome_path="${MEETING_COPILOT_CHROME_PATH:-}"
if [ -z "$chrome_path" ]; then
  chrome_path="$(find_chrome || true)"
fi

if [ -z "$chrome_path" ] || [ ! -d "$chrome_path" ]; then
  printf 'Google Chrome was not found.\n' >&2
  exit 1
fi

chrome_binary="$chrome_path/Contents/MacOS/${chrome_path##*/}"
chrome_binary="${chrome_binary%.app}"
if [ ! -x "$chrome_binary" ]; then
  printf 'Chrome executable was not found at %s.\n' "$chrome_binary" >&2
  exit 1
fi

profile_dir="${MEETING_COPILOT_PROFILE_DIR:-$HOME/Library/Application Support/MeetingCopilot/GPTParticipantChrome}"
cdp_port="${MEETING_COPILOT_CDP_PORT:-9223}"

if [ "$dry_run" -eq 1 ]; then
  printf '[DRY RUN] open -na %q --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=%q --use-fake-ui-for-media-stream --user-data-dir=%q --no-first-run --new-window %q\n' \
    "$chrome_path" "$cdp_port" "$profile_dir" "$agent_url"
  exit 0
fi

if [ ! -d "$repo_root/node_modules/playwright-core" ]; then
  printf 'playwright-core is required. Run: npm ci\n' >&2
  exit 1
fi

mkdir -p "$profile_dir"

find_profile_pids() {
  ps -axo pid=,command= | awk -v profile="--user-data-dir=$profile_dir" '
    index($0, profile) && $0 ~ /Contents\/MacOS\// && $0 !~ /Helper/ { print $1 }
  '
}

dedicated_endpoint_ready() {
  node "$repo_root/scripts/verify-dedicated-chrome.mjs" \
    --profile-dir "$profile_dir" --port "$cdp_port" >/dev/null 2>&1
}

launch_chrome=1
profile_pids="$(find_profile_pids)"
if [ -n "$profile_pids" ]; then
  if [ "$restart_profile" -eq 1 ]; then
    printf '[INFO] Restarting shared Meetron Chrome profile.\n'
    for profile_pid in $profile_pids; do
      kill "$profile_pid" 2>/dev/null || true
    done

    attempts=0
    while [ -n "$(find_profile_pids)" ] && [ "$attempts" -lt 20 ]; do
      sleep 0.25
      attempts=$((attempts + 1))
    done
  elif dedicated_endpoint_ready; then
    launch_chrome=0
    printf '[INFO] Reusing shared Meetron Chrome profile.\n'
  else
    printf 'The shared Chrome profile is running without its automation endpoint.\n' >&2
    printf 'Close it, then run the command again.\n' >&2
    exit 1
  fi
fi

if [ "$launch_chrome" -eq 1 ]; then
  open -na "$chrome_path" --args \
    --remote-debugging-address=127.0.0.1 \
    "--remote-debugging-port=$cdp_port" \
    --use-fake-ui-for-media-stream \
    "--user-data-dir=$profile_dir" \
    --no-first-run \
    --new-window \
    "$agent_url"
fi

attempts=0
while ! dedicated_endpoint_ready; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 40 ]; then
    printf 'Chrome automation endpoint did not start on port %s.\n' "$cdp_port" >&2
    exit 1
  fi
  sleep 0.25
done

prepare_args=(
  --cdp "http://127.0.0.1:$cdp_port"
  --agent-url "$agent_url"
)
if [ "$replace_tab" -eq 1 ]; then
  prepare_args+=(--replace-tab)
fi

set +e
node "$repo_root/scripts/prepare-agent.mjs" "${prepare_args[@]}"
prepare_status=$?
set -e

if [ "$prepare_status" -eq 10 ]; then
  printf '\nSign in to Gastrobrain in the dedicated browser, then rerun this command.\n'
  exit 10
fi

exit "$prepare_status"
