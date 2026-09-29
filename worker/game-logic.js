// game-logic.js — server-side copy of the puzzle algorithm in files/script.js.
// Kept in sync by hand: DAILY_LENGTHS/DAILY_PAR_RANGE/EPOCH and the generation
// algorithm must match the client exactly, or the server will compute a
// different "canonical" daily puzzle than players are actually solving.
import { WORDS } from "./words-data.js";

// Must match files/script.js exactly, including the "Z" (explicit UTC) —
// see the comment there for why it matters.
export const EPOCH = new Date("2026-07-27T00:00:00Z");
export const DAILY_LENGTHS = [5];
export const DAILY_PAR_RANGE = [3, 5];

export function neighbors(word) {
  const out = [];
  for (let i = 0; i < word.length; i++) {
    const prefix = word.slice(0, i);
    const suffix = word.slice(i + 1);
    for (let c = 65; c <= 90; c++) {
      const ch = String.fromCharCode(c);
      if (ch === word[i]) continue;
      const cand = prefix + ch + suffix;
      if (WORDS.has(cand)) out.push(cand);
    }
  }
  return out;
}

export function bfsDistances(start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = dist.get(cur);
    for (const n of neighbors(cur)) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

export function diffByOne(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function dayIndexForNow() {
  const now = new Date();
  return Math.floor((now - EPOCH) / 86400000);
}

// Must match files/script.js's dailyStartOrder()/generateDailyPuzzle()
// exactly (same seed, same shuffle, same goal-selection logic) — this is
// what lets the server independently recompute "today's puzzle" and
// validate a submitted chain against it.
const DAILY_SHUFFLE_SEED = 1337;
let _dailyStartOrderCache = null;
function dailyStartOrder(commonByLength) {
  if (!_dailyStartOrderCache) {
    const arr = commonByLength[DAILY_LENGTHS[0]].slice();
    const rng = mulberry32(DAILY_SHUFFLE_SEED);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    _dailyStartOrderCache = arr;
  }
  return _dailyStartOrderCache;
}

export function canonicalDailyPuzzle(idx, commonByLength) {
  const pool = commonByLength[DAILY_LENGTHS[0]];
  const order = dailyStartOrder(commonByLength);
  const start = order[idx % order.length];
  const rng = mulberry32(idx + 1);
  const dist = bfsDistances(start);

  let candidates = pool.filter(w =>
    w !== start && dist.has(w) && dist.get(w) >= DAILY_PAR_RANGE[0] && dist.get(w) <= DAILY_PAR_RANGE[1]);
  if (candidates.length === 0) {
    candidates = [];
    for (const [w, d] of dist) {
      if (w !== start && d >= DAILY_PAR_RANGE[0] && d <= DAILY_PAR_RANGE[1]) candidates.push(w);
    }
  }
  if (candidates.length > 0) {
    const goal = pick(rng, candidates);
    return { start, end: goal, par: dist.get(goal) };
  }
  let bestWord = null, bestDist = 0;
  for (const [w, d] of dist) {
    if (w !== start && d > bestDist) { bestDist = d; bestWord = w; }
  }
  if (bestWord) return { start, end: bestWord, par: bestDist };
  return null;
}

// Validates a claimed solve chain against the canonical puzzle for a given
// day. Confirms the path is a genuine sequence of real one-letter-away
// dictionary words from start to goal — it cannot detect a faked elapsed
// time, since that's self-reported by the client.
export function validateChain(chain, puzzle) {
  if (!Array.isArray(chain) || chain.length < 2) return false;
  if (chain.length > 60) return false; // sanity cap
  if (chain[0] !== puzzle.start) return false;
  if (chain[chain.length - 1] !== puzzle.end) return false;
  for (let i = 0; i < chain.length; i++) {
    const w = chain[i];
    if (typeof w !== "string" || !/^[A-Z]+$/.test(w)) return false;
    if (w.length !== puzzle.start.length) return false;
    if (i > 0) {
      if (!diffByOne(chain[i - 1], w)) return false;
      if (!WORDS.has(w)) return false;
    }
  }
  return true;
}
