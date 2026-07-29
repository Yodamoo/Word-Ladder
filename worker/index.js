// index.js — Worker entry point. Handles /api/leaderboard/* routes and
// forwards everything else to the static assets (the game itself).
import { COMMON_BY_LENGTH } from "./words-data.js";
import { dayIndexForNow, canonicalDailyPuzzle, validateChain } from "./game-logic.js";

// The Android app's WebView loads the game from a local origin (not this
// domain), so its API calls are cross-origin and need CORS allowed —
// there's no session/cookie auth here to protect, just a public leaderboard.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
  const safeName = sanitizeName(name);
  const submittedAt = Date.now();
  const timeSeconds = Math.round(elapsedSeconds);

  // day_index+player_id is the primary key, so INSERT OR IGNORE means a
  // player's first submitted result each day is their only one — resubmitting
  // can't overwrite it with a faster (or faked) time later.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_scores (day_index, player_id, name, time_seconds, steps, hints, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(idx, playerId, safeName, timeSeconds, steps, hintsNum, submittedAt).run();

  return json({ ok: true, accepted: result.meta.changes > 0 });
}

async function handleToday(request, env) {
  const idx = dayIndexForNow();

  const firstRow = await env.DB.prepare(
    `SELECT name, submitted_at FROM daily_scores WHERE day_index = ? ORDER BY submitted_at ASC LIMIT 1`
  ).bind(idx).first();

  const rankedRes = await env.DB.prepare(
    `SELECT name, time_seconds FROM daily_scores WHERE day_index = ? AND hints = 0 ORDER BY time_seconds ASC LIMIT 20`
  ).bind(idx).all();

  const assistedRes = await env.DB.prepare(
    `SELECT name, time_seconds FROM daily_scores WHERE day_index = ? AND hints > 0 ORDER BY time_seconds ASC LIMIT 20`
  ).bind(idx).all();

  return json({
    dayIndex: idx,
    first: firstRow ? { name: firstRow.name } : null,
    ranked: (rankedRes.results || []).map(r => ({ name: r.name, timeSeconds: r.time_seconds })),
    assisted: (assistedRes.results || []).map(r => ({ name: r.name, timeSeconds: r.time_seconds })),
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
    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
