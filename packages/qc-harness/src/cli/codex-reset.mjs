import { setTimeout as sleep } from "node:timers/promises";

const STATUS_URL = "https://codex-resets.com/api/v1/status";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TIMER_MS = 2147483647;
const MAX_POLL_MINUTES = Math.floor(MAX_TIMER_MS / MINUTE_MS);
const USAGE = "usage: qc codex-wait-reset --since <iso> [--max-hours <n>] [--poll-minutes <n>]\nexit 0 on a reset, 1 at the bound or on bad input";

/** Branch: validates the shared poll interval before a request starts. */
export function parsePollMinutes(value = 30) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_POLL_MINUTES) {
    throw new Error(`--poll-minutes must be a positive finite number up to ${MAX_POLL_MINUTES} minutes`);
  }
  return minutes;
}

/** Branch: validates the shared wait bound before a request starts. */
export function parseMaxHours(value = 6) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * HOUR_MS)) {
    throw new Error("--max-hours must be a positive finite number");
  }
  return hours;
}

/** Pipeline: polls without a model until a reset follows the usage limit or the bound expires. */
export async function waitForCodexReset({
  since, maxHours = 6, pollMinutes = 30, fetch = globalThis.fetch, now = Date.now, sleep: pause = sleep,
  say = (line) => console.error(line),
}) {
  const hit = Date.parse(since);
  if (!Number.isFinite(hit)) throw new Error("--since must be an ISO timestamp");
  const deadline = now() + parseMaxHours(maxHours) * HOUR_MS;
  const pollMs = parsePollMinutes(pollMinutes) * MINUTE_MS;
  say(`qc codex-wait-reset: waiting for a reset after ${since}`);
  while (now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(30000, Math.ceil(deadline - now()))));
      const response = await fetch(STATUS_URL, { signal });
      if (!response.ok) throw new Error(`status endpoint returned HTTP ${response.status}`);
      const body = await response.json();
      const announced = Date.parse(body?.data?.latest_reset?.announced_at);
      if (now() < deadline && announced > hit) {
        say(`qc codex-wait-reset: reset announced at ${body.data.latest_reset.announced_at}`);
        return true;
      }
    } catch (error) {
      say(`qc codex-wait-reset: ${error.message}; polling continues`);
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(pollMs, remaining));
  }
  say("qc codex-wait-reset: wait bound reached");
  return false;
}

/** Trigger: runs the standalone wait command with injectable network and clock functions. */
export async function runCodexWaitReset(argv, { say = (line) => console.error(line), ...options } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { say(USAGE); return 0; }
  try {
    const flags = {};
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      if (flag !== "--since" && flag !== "--max-hours" && flag !== "--poll-minutes") throw new Error(`unknown argument ${flag}`);
      if (argv[index + 1] === undefined) throw new Error(`${flag} needs a value`);
      flags[flag] = argv[index + 1];
    }
    return await waitForCodexReset({
      ...options, since: flags["--since"], maxHours: parseMaxHours(flags["--max-hours"]),
      pollMinutes: parsePollMinutes(flags["--poll-minutes"]), say,
    }) ? 0 : 1;
  } catch (error) {
    say(`qc codex-wait-reset: ${error.message}\n${USAGE}`);
    return 1;
  }
}
