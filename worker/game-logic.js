// game-logic.js — server-side copy of the puzzle algorithm in files/script.js.
// Kept in sync by hand: DAILY_LENGTHS/DAILY_PAR_RANGE/EPOCH and the generation
// algorithm must match the client exactly, or the server will compute a
// different "canonical" daily puzzle than players are actually solving.
import { WORDS } from "./words-data.js";

export const EPOCH = new Date("2026-07-27T00:00:00");
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

export function generatePuzzle(rng, lengths, parRange, commonByLength) {
  let lastDist = null;
  let lastStart = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const length = pick(rng, lengths);
    const pool = commonByLength[length];
    if (!pool || pool.length === 0) continue;
    const start = pick(rng, pool);
    const dist = bfsDistances(start);
    lastDist = dist; lastStart = start;

    let candidates = pool.filter(w =>
      w !== start && dist.has(w) && dist.get(w) >= parRange[0] && dist.get(w) <= parRange[1]);

    if (candidates.length === 0) {
      candidates = [];
      for (const [w, d] of dist) {
        if (w !== start && d >= parRange[0] && d <= parRange[1]) candidates.push(w);
      }
    }
    if (candidates.length === 0) continue;

    const goal = pick(rng, candidates);
    return { start, end: goal, par: dist.get(goal) };
  }
  if (lastDist) {
    let bestWord = null, bestDist = 0;
    for (const [w, d] of lastDist) {
      if (w !== lastStart && d > bestDist) { bestDist = d; bestWord = w; }
    }
    if (bestWord) return { start: lastStart, end: bestWord, par: bestDist };
  }
  return null;
}

export function dayIndexForNow() {
  const now = new Date();
  return Math.floor((now - EPOCH) / 86400000);
}

export function canonicalDailyPuzzle(idx, commonByLength) {
  const rng = mulberry32(idx + 1);
  return generatePuzzle(rng, DAILY_LENGTHS, DAILY_PAR_RANGE, commonByLength);
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
  const seen = new Set();
  for (let i = 0; i < chain.length; i++) {
    const w = chain[i];
    if (typeof w !== "string" || !/^[A-Z]+$/.test(w)) return false;
    if (w.length !== puzzle.start.length) return false;
    if (seen.has(w)) return false;
    seen.add(w);
    if (i > 0) {
      if (!diffByOne(chain[i - 1], w)) return false;
      if (!WORDS.has(w)) return false;
    }
  }
  return true;
}
