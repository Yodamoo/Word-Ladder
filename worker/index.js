// index.js — Worker entry point. Handles /api/leaderboard/* routes and
// forwards everything else to the static assets (the game itself).
import { COMMON_BY_LENGTH } from "./words-data.js";
import { dayIndexForNow, canonicalDailyPuzzle, validateChain } from "./game-logic.js";
import { isNameAllowed } from "./name-filter.js";

// The Android app's WebView loads the game from a local origin (not this
// domain), so its API calls are cross-origin and need CORS allowed —
// there's no session/cookie auth here to protect, just a public leaderboard.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Player-Id",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "Anonymous";
  const trimmed = raw.trim().slice(0, 24);
  return trimmed || "Anonymous";
}

// Applied on read as well as write, so tightening the filter later also
// cleans up names that are already stored.
function displayName(name) {
  return isNameAllowed(name) ? name : "Anonymous";
}

async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const { playerId, name, chain, hints, elapsedSeconds } = body || {};
  if (typeof playerId !== "string" || playerId.length < 8 || playerId.length > 100) {
    return json({ ok: false, error: "invalid playerId" }, 400);
  }
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || elapsedSeconds > 86400) {
    return json({ ok: false, error: "invalid elapsedSeconds" }, 400);
  }
  const hintsNum = Number.isInteger(hints) ? hints : 0;
  if (hintsNum < 0 || hintsNum > 50) {
    return json({ ok: false, error: "invalid hints" }, 400);
  }

  const idx = dayIndexForNow();
  const puzzle = canonicalDailyPuzzle(idx, COMMON_BY_LENGTH);
  if (!puzzle) return json({ ok: false, error: "no puzzle today" }, 500);

  if (!validateChain(chain, puzzle)) {
    return json({ ok: false, error: "invalid chain" }, 400);
  }

  const steps = chain.length - 1;
  const cleaned = sanitizeName(name);
  const nameRejected = !isNameAllowed(cleaned);
  const safeName = nameRejected ? "Anonymous" : cleaned;
  const submittedAt = Date.now();
  const timeSeconds = Math.round(elapsedSeconds);

  // day_index+player_id is the primary key, so INSERT OR IGNORE means a
  // player's first submitted result each day is their only one — resubmitting
  // can't overwrite it with a faster (or faked) time later.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_scores (day_index, player_id, name, time_seconds, steps, hints, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(idx, playerId, safeName, timeSeconds, steps, hintsNum, submittedAt).run();

  return json({ ok: true, accepted: result.meta.changes > 0, nameRejected });
}

async function handleToday(request, env) {
  const idx = dayIndexForNow();
  // The caller's own ID arrives in a header (not the URL, so it stays out of
  // logs) and is only used to flag their rows — other players' IDs are never
  // sent back.
  const me = request.headers.get("X-Player-Id") || "";

  const firstRow = await env.DB.prepare(
    `SELECT name, player_id FROM daily_scores WHERE day_index = ? ORDER BY submitted_at ASC LIMIT 1`
  ).bind(idx).first();

  const rankedRes = await env.DB.prepare(
    `SELECT name, player_id, time_seconds, steps FROM daily_scores WHERE day_index = ? AND hints = 0 ORDER BY time_seconds ASC LIMIT 20`
  ).bind(idx).all();

  const bySteps = await env.DB.prepare(
    `SELECT name, player_id, time_seconds, steps FROM daily_scores WHERE day_index = ? AND hints = 0 ORDER BY steps ASC, time_seconds ASC LIMIT 20`
  ).bind(idx).all();

  const assistedRes = await env.DB.prepare(
    `SELECT name, player_id, time_seconds, steps FROM daily_scores WHERE day_index = ? AND hints > 0 ORDER BY time_seconds ASC LIMIT 20`
  ).bind(idx).all();

  const row = r => ({
    name: displayName(r.name), timeSeconds: r.time_seconds, steps: r.steps,
    isMe: me !== "" && r.player_id === me,
  });

  // Your own result and rank, even when you're outside the top 20.
  let mine = null;
  if (me) {
    const own = await env.DB.prepare(
      `SELECT time_seconds, steps, hints FROM daily_scores WHERE day_index = ? AND player_id = ?`
    ).bind(idx, me).first();
    if (own) {
      mine = { timeSeconds: own.time_seconds, steps: own.steps, hints: own.hints, rankTime: null, rankSteps: null };
      if (own.hints === 0) {
        const t = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM daily_scores WHERE day_index = ? AND hints = 0 AND time_seconds < ?`
        ).bind(idx, own.time_seconds).first();
        const s = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM daily_scores WHERE day_index = ? AND hints = 0
             AND (steps < ? OR (steps = ? AND time_seconds < ?))`
        ).bind(idx, own.steps, own.steps, own.time_seconds).first();
        mine.rankTime = t.n + 1;
        mine.rankSteps = s.n + 1;
      }
    }
  }

  return json({
    dayIndex: idx,
    first: firstRow ? { name: displayName(firstRow.name), isMe: me !== "" && firstRow.player_id === me } : null,
    ranked: (rankedRes.results || []).map(row),
    bySteps: (bySteps.results || []).map(row),
    assisted: (assistedRes.results || []).map(row),
    me: mine,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/api/leaderboard/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }
    if (url.pathname === "/api/leaderboard/today" && request.method === "GET") {
      return handleToday(request, env);
    }
    if (url.pathname === "/api/name/check" && request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (e) { /* handled below */ }
      if (!body || typeof body.name !== "string") return json({ ok: false, error: "invalid name" }, 400);
      return json({ ok: true, allowed: isNameAllowed(sanitizeName(body.name)) });
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
