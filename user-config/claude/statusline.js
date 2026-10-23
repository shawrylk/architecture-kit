// Three-line powerline status line for Claude Code.
// Needs a Nerd Font in the terminal for the branch, arrow and building
// glyphs (U+E0A0, U+E0B0, U+F1AD); every other icon is plain Unicode.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARROW = '';
const BRANCH_ICON = '';
const BUILDING_ICON = '';

const WHITE = [255, 255, 255];
const ORANGE_BROWN = [166, 88, 39];
const DARK_GREY = [58, 58, 58];
const SLATE = [92, 105, 138];
const RED = [178, 34, 34];
const NAVY = [16, 26, 58];
const GREEN = [30, 120, 60];
const BLUE = [30, 80, 170];
const AMBER = [196, 110, 0];

function fg(rgb) { return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`; }
function bg(rgb) { return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`; }
const RESET = '\x1b[0m';

// Renders one powerline row: each segment gets a solid background and white
// text, and an arrow that shades into the next segment's background (or
// fades to the terminal background after the last segment in the row).
function renderLine(segments) {
  const visible = segments.filter(Boolean);
  if (visible.length === 0) return null;
  let out = '';
  for (let i = 0; i < visible.length; i++) {
    const seg = visible[i];
    const next = visible[i + 1];
    out += `${fg(WHITE)}${bg(seg.color)} ${seg.text} `;
    out += next
      ? `${fg(seg.color)}${bg(next.color)}${ARROW}`
      : `${RESET}${fg(seg.color)}${ARROW}${RESET}`;
  }
  return out;
}

// Replaces the home directory prefix with `~`, the way a shell prompt does.
function tildePath(dir) {
  const home = os.homedir().replace(/\\/g, '/').replace(/\/$/, '');
  const norm = dir.replace(/\\/g, '/');
  if (norm.toLowerCase() === home.toLowerCase()) return '~';
  if (norm.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return `~${norm.slice(home.length)}`;
  return norm;
}

// One git call carries branch, ahead/behind and dirty status together,
// instead of running three separate processes on every render.
function gitInfo(dir) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['-C', dir, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString();
  } catch {
    return null; // Not a repository, or git is missing.
  }

  let branch = '';
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line && !line.startsWith('#')) {
      dirty = true;
    }
  }

  if (!branch || branch === '(detached)') {
    try {
      branch = execFileSync(
        'git',
        ['-C', dir, '--no-optional-locks', 'rev-parse', '--short', 'HEAD'],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
    } catch { /* leave branch as whatever branch.head reported */ }
  }

  return { branch, ahead, behind, dirty };
}

function gitSegmentText(info) {
  let text = `${BRANCH_ICON} ${info.branch}`;
  if (info.ahead > 0) text += ` ↑${info.ahead}`;
  if (info.behind > 0) text += ` ↓${info.behind}`;
  if (info.dirty) text += ' ●';
  return text;
}

// Formats a duration as "1h 52m" or "6d 13h", matching the two rate-limit
// reset examples: minutes only under an hour, hours dropped past a day.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function dotBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '●'.repeat(filled) + '○'.repeat(10 - filled);
}

function boxBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▮'.repeat(filled) + '▯'.repeat(10 - filled);
}

// Context against the auto-compact window (autoCompactWindow in settings.json), not the model's 1M window.
const COMPACT_WINDOW = 233000;
function contextText(pct, size) {
  if (typeof size !== 'number' || size <= 0) return `◔ ${Math.round(pct)}%`;
  const used = (pct / 100) * size;
  return `◔ ${Math.round(used / 1000)}K/${COMPACT_WINDOW / 1000}K (${Math.round((used / COMPACT_WINDOW) * 100)}%)`;
}

// The fraction of the seven-day window elapsed so far, as a percentage, so
// the pace segment can compare actual usage against the expected usage.
function weeklyExpectedPct(resetsAt, nowSec) {
  const WINDOW = 7 * 86400;
  const windowStart = resetsAt - WINDOW;
  const elapsed = Math.min(WINDOW, Math.max(0, nowSec - windowStart));
  return (elapsed / WINDOW) * 100;
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// The account email lives in .claude.json, next to (or above) the settings
// the status line command itself is read from, never in the stdin payload.
function readAccountEmail() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  candidates.push(path.join(os.homedir(), '.claude.json'));
  for (const file of candidates) {
    try {
      const email = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.emailAddress;
      if (email) return email;
    } catch { /* try the next candidate */ }
  }
  return null;
}

// ---- Codex usage ----------------------------------------------------------
const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const CODEX_CACHE = path.join(configDir(), 'codex-usage-cache.json');
const CODEX_TTL_SEC = 60;
const CODEX_TAIL_BYTES = 256 * 1024;

function dayDir(d) {
  const p = (n) => String(n).padStart(2, '0');
  return path.join(CODEX_SESSIONS, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
}

function newestCodexFiles(count) {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const files = [];
  for (const d of [now, yesterday]) {
    const dir = dayDir(d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const full = path.join(dir, n);
      try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, count);
}

function lastRateLimits(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, CODEX_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits":')) continue;
      try {
        const obj = JSON.parse(lines[i]);
        const rl = obj?.payload?.rate_limits ?? obj?.rate_limits ?? obj?.payload?.info?.rate_limits;
        if (rl && typeof rl === 'object' && (rl.primary || rl.secondary)) return rl;
      } catch { /* partial first line or unrelated JSON: keep looking */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function codexWindows(nowSec) {
  let cached;
  try {
    const c = JSON.parse(fs.readFileSync(CODEX_CACHE, 'utf8'));
    if (typeof c.at === 'number' && nowSec - c.at < CODEX_TTL_SEC) cached = c;
  } catch { /* no usable cache */ }
  if (cached) return cached.windows;

  let windows = null;
  for (const f of newestCodexFiles(3)) {
    let rl = null;
    try { rl = lastRateLimits(f.full); } catch { /* try the next file */ }
    if (rl) {
      windows = [rl.primary, rl.secondary]
        .filter((w) => w && typeof w.used_percent === 'number' && typeof w.resets_at === 'number')
        .map((w) => ({ used: w.used_percent, minutes: w.window_minutes, resetsAt: w.resets_at }));
      break;
    }
  }
  try { fs.writeFileSync(CODEX_CACHE, JSON.stringify({ at: nowSec, windows })); } catch { /* cache is optional */ }
  return windows;
}

function codexSegment(nowSec) {
  try {
    const windows = codexWindows(nowSec);
    if (!windows || windows.length === 0) return null;
    const parts = [];
    let minLeft = 100;
    windows.forEach((w, i) => {
      const label = i === 0 ? 'codex' : `codex ${w.minutes === 300 ? '5h' : w.minutes ? `${Math.round(w.minutes / 60)}h` : '2nd'}`;
      if (w.resetsAt <= nowSec) { parts.push(`${label} reset`); return; }
      const left = Math.max(0, Math.min(100, Math.round(100 - w.used)));
      minLeft = Math.min(minLeft, left);
      const d = new Date(w.resetsAt * 1000);
      const day = d.toLocaleDateString('en-US', { weekday: 'short' });
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const sameDay = d.toDateString() === new Date(nowSec * 1000).toDateString();
      parts.push(`${label} ${left}% left · resets ${sameDay ? hm : `${day} ${hm}`}`);
    });
    const color = minLeft > 50 ? GREEN : minLeft >= 20 ? AMBER : RED;
    return { text: parts.join(' · '), color };
  } catch {
    return null;
  }
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch { /* render what defaults allow */ }

  const nowSec = Math.floor(Date.now() / 1000);
  const dir = j.workspace?.current_dir || j.cwd || process.cwd();
  const git = gitInfo(dir);
  const ctxPct = j.context_window?.used_percentage;
  const model = j.model?.display_name;
  const fiveHour = j.rate_limits?.five_hour;
  const sevenDay = j.rate_limits?.seven_day;
  const email = readAccountEmail();

  // Leave the weekly usage where an agent can read it, since no tool exposes it.
  if (sevenDay) {
    try {
      require('fs').writeFileSync(
        require('path').join(process.env.CLAUDE_CONFIG_DIR || require('os').homedir() + '/.claude', 'weekly-usage.json'),
        JSON.stringify({ used_percentage: sevenDay.used_percentage, resets_at: sevenDay.resets_at, at: nowSec }),
      );
    } catch { /* the status line must render even if the write fails */ }
  }

  const line1 = [
    { text: tildePath(dir), color: ORANGE_BROWN },
    git ? { text: gitSegmentText(git), color: DARK_GREY } : null,
    typeof ctxPct === 'number' ? { text: contextText(ctxPct, j.context_window?.context_window_size), color: SLATE } : null,
  ];

  const line2 = [
    model ? { text: `✱ ${model}`, color: RED } : null,
    fiveHour ? {
      text: `◱ ${dotBar(fiveHour.used_percentage)} ${Math.round(fiveHour.used_percentage)}% (${formatDuration(fiveHour.resets_at - nowSec)})`,
      color: NAVY,
    } : null,
    sevenDay ? {
      text: `◑ ${boxBar(sevenDay.used_percentage)} ${Math.round(sevenDay.used_percentage)}% (${formatDuration(sevenDay.resets_at - nowSec)})`,
      color: GREEN,
    } : null,
  ];

  let weeklyPace = null;
  if (sevenDay) {
    const used = Math.round(sevenDay.used_percentage);
    const expected = Math.round(weeklyExpectedPct(sevenDay.resets_at, nowSec));
    const onPace = used <= expected;
    weeklyPace = {
      text: `${onPace ? '✓' : '⚠'} weekly ${used}% ${onPace ? '≤' : '>'} ${expected}%`,
      color: onPace ? GREEN : AMBER,
    };
  }

  const line3 = [
    email ? { text: `⚙ ${email}`, color: DARK_GREY } : null,
    { text: `${BUILDING_ICON} ${path.basename(configDir())}`, color: BLUE },
    weeklyPace,
    codexSegment(nowSec),
  ];

  const out = [renderLine(line1), renderLine(line2), renderLine(line3)].filter(Boolean).join('\n');
  process.stdout.write(out);
});
