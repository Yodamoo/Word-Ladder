// script.js — Rungs game engine

// Absolute, not relative: inside the Capacitor app the page loads from a
// local WebView origin, not the real domain, so a relative "/api/..." would
// hit the wrong host. The web version is same-origin either way, so this is
// harmless there too.
const API_BASE = "https://word-ladder.yodamoo.workers.dev";

// The "Z" is load-bearing: without it, this parses in the device's local
// timezone, so day boundaries would roll over at local midnight on the
// client but at UTC midnight on the server (Workers always run in UTC) —
// they'd disagree for hours every day for anyone outside UTC.
const EPOCH = new Date("2026-07-27T00:00:00Z");

const DIFFICULTIES = {
  easy:   { label: "Easy",   lengths: [3, 4],    parRange: [2, 3] },
  medium: { label: "Medium", lengths: [5],       parRange: [3, 5] },
  hard:   { label: "Hard",   lengths: [6, 7],    parRange: [4, 7] },
};

// Daily challenge is always 5 letters so every player compares the same
// puzzle shape day to day (same idea as Wordle keeping a fixed word length).
const DAILY_LENGTHS = [5];
const DAILY_PAR_RANGE = [3, 5];

// --- Word-ladder graph: neighbors are found by trying every letter in every
// position rather than shipping precomputed adjacency, since a Set lookup is
// cheap regardless of dictionary size.
function neighbors(word) {
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

function bfsDistances(start) {
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

// Hint: the next word along a shortest path from `fromWord` to `goal`,
// avoiding words already used in the chain (so it can't suggest a loop).
// Recomputed from the player's current position rather than the original
// puzzle path, so it stays valid even after detours.
function nextHintWord(fromWord, goal, usedWords) {
  if (fromWord === goal) return null;
  const blocked = new Set(usedWords);
  blocked.delete(goal);

  const dist = new Map([[fromWord, 0]]);
  const prev = new Map();
  const queue = [fromWord];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const n of neighbors(cur)) {
      if (blocked.has(n) || dist.has(n)) continue;
      dist.set(n, dist.get(cur) + 1);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!dist.has(goal)) return null;

  let cur = goal;
  const path = [cur];
  while (cur !== fromWord) { cur = prev.get(cur); path.push(cur); }
  path.reverse();
  return path[1];
}

// --- Seeded RNG (mulberry32) so the daily puzzle is identical for everyone
// who loads the page on the same day, with no server required.
function mulberry32(seed) {
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

// Fixed Fisher-Yates shuffle (seeded once, not per-day) of the daily word
// pool, so indexing into it by day number visits every word exactly once
// before any repeat — about 3.26 years at the current ~1192-word pool,
// instead of a plain random pick repeating within weeks by chance alone.
const DAILY_SHUFFLE_SEED = 1337;
let _dailyStartOrderCache = null;
function dailyStartOrder() {
  if (!_dailyStartOrderCache) {
    const arr = COMMON_BY_LENGTH[DAILY_LENGTHS[0]].slice();
    const rng = mulberry32(DAILY_SHUFFLE_SEED);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    _dailyStartOrderCache = arr;
  }
  return _dailyStartOrderCache;
}

// Daily-pool words that can't reach any word 3+ steps away (no neighbours at
// all, or stuck in a tiny island), so they'd crash or make a 1-2 step daily.
// Precomputed rather than checked at load time; regenerate if the word lists
// change. Must match worker/game-logic.js exactly.
const DAILY_UNPLAYABLE_STARTS = new Set([
  "ACTOR","ADMIT","ADOPT","ADULT","AGAIN","AHEAD","ALBUM","ALIEN","ALIGN","ALPHA","ANGRY","ANNEX",
  "ARROW","ASSET","AUDIO","AUDIT","AUTOS","AVOID","AWFUL","BELOW","CLAIM","CYCLE","DELTA","DILDO",
  "DOUBT","EAGLE","EMPTY","ENEMY","ENJOY","ENTRY","EQUAL","ERROR","ESSAY","EXACT","EXAMS","EXCEL",
  "EXIST","EXTRA","FIBRE","FIELD","FIRST","FRAUD","GNOME","HONDA","HUMAN","HUMOR","IMAGE","INDEX",
  "INPUT","INTRO","ISSUE","IVORY","JAPAN","JUICE","KARMA","KNIFE","LEONE","MAYBE","MERIT","OCCUR",
  "OMEGA","OPERA","ORBIT","ORGAN","OUGHT","OXIDE","OZONE","PIZZA","PROOF","PROUD","QUEEN","QUEUE",
  "RADAR","RALPH","REHAB","ROBOT","RUGBY","SIGMA","SPERM","SUGAR","THEFT","THEIR","THETA","TUMOR",
  "TURBO","TWIST","ULTRA","UNCLE","UNTIL","URBAN","USAGE","USERS","USING","USUAL","VISIT","WAGON",
  "WIDTH","XEROX","YACHT","YAHOO","YIELD","YOUNG",
]);

// From this day on, unplayable start words are skipped. Earlier days keep
// their original start words so puzzles already played (and scores already on
// the leaderboard) never change underneath anyone.
const DAILY_FILTER_FROM_DAY = 100;
let _playableTailCache = null, _playableAllCache = null;
function dailyStartWord(idx) {
  const order = dailyStartOrder();
  if (idx < DAILY_FILTER_FROM_DAY) return order[idx % order.length];
  if (!_playableTailCache) {
    const playable = w => !DAILY_UNPLAYABLE_STARTS.has(w);
    _playableTailCache = order.slice(DAILY_FILTER_FROM_DAY).filter(playable);
    _playableAllCache = order.filter(playable);
  }
  const i = idx - DAILY_FILTER_FROM_DAY;
  if (i < _playableTailCache.length) return _playableTailCache[i];
  const j = i - _playableTailCache.length;
  return _playableAllCache[j % _playableAllCache.length];
}

// Like generatePuzzle, but the start word is fixed (from dailyStartWord)
// rather than randomly picked, so the daily challenge never repeats a start
// word until the whole pool has cycled. Only the goal is chosen via the
// day-seeded RNG, same as before.
function generateDailyPuzzle(idx) {
  const pool = COMMON_BY_LENGTH[DAILY_LENGTHS[0]];
  const start = dailyStartWord(idx);
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
  // Fallback: take whatever's reachable at the greatest distance we found.
  let bestWord = null, bestDist = 0;
  for (const [w, d] of dist) {
    if (w !== start && d > bestDist) { bestDist = d; bestWord = w; }
  }
  if (bestWord) return { start, end: bestWord, par: bestDist };
  return null;
}

function generatePuzzle(rng, lengths, parRange) {
  let lastDist = null;
  let lastStart = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const length = pick(rng, lengths);
    const pool = COMMON_BY_LENGTH[length];
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
  // Fallback: take whatever's reachable at the greatest distance we found.
  if (lastDist) {
    let bestWord = null, bestDist = 0;
    for (const [w, d] of lastDist) {
      if (w !== lastStart && d > bestDist) { bestDist = d; bestWord = w; }
    }
    if (bestWord) return { start: lastStart, end: bestWord, par: bestDist };
  }
  return null;
}

function dayIndex() {
  const now = new Date();
  return Math.floor((now - EPOCH) / 86400000);
}

function dailyPuzzleFor(idx) {
  // Fallback keeps the page playable if generation ever fails; the server
  // won't rank that puzzle, but a playable game beats a blank screen.
  const puzzle = generateDailyPuzzle(idx)
    || generatePuzzle(mulberry32(idx + 1), DAILY_LENGTHS, DAILY_PAR_RANGE);
  return { idx, puzzle };
}

function dailyPuzzle() {
  return dailyPuzzleFor(dayIndex());
}

function dayDateLabel(idx) {
  const d = new Date(EPOCH.getTime() + idx * 86400000);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// One shortest route (there are often several), shown after solving.
function shortestPath(start, goal) {
  const prev = new Map([[start, null]]);
  const queue = [start];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur === goal) break;
    for (const n of neighbors(cur)) {
      if (!prev.has(n)) { prev.set(n, cur); queue.push(n); }
    }
  }
  if (!prev.has(goal)) return null;
  const path = [];
  for (let w = goal; w !== null; w = prev.get(w)) path.push(w);
  return path.reverse();
}

// The route a player is actually on, ignoring detours they backed out of:
// stepping onto the word before the current one counts as undoing the last
// step. Returns indices into `words`; the latest word is always included,
// so e.g. A B C B -> [A, latest B] and the earlier B + C render as a detour.
function effectivePathIndices(words) {
  const stack = [];
  words.forEach((w, i) => {
    if (stack.length >= 2 && words[stack[stack.length - 2]] === w) {
      stack.pop();
      stack[stack.length - 1] = i;
    } else {
      stack.push(i);
    }
  });
  return stack;
}

function practicePuzzle(difficulty) {
  const rng = mulberry32(Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF));
  const tier = DIFFICULTIES[difficulty];
  return generatePuzzle(rng, tier.lengths, tier.parRange);
}

// --- Game state ---
let mode = "daily"; // "daily" | "practice" | "archive"
let difficulty = localStorage.getItem("rungs:difficulty") || "medium";
let daily = dailyPuzzle();
let practice = null; // { start, end, par }
let archive = null; // { idx, puzzle } — a past daily, replayed unranked
let chain = [];
let won = false;
let hintCount = 0;
let hintPosition = null; // index of the letter to change next, or null
let startedAt = Date.now(); // when the current puzzle attempt began, for daily timing
let pendingSubmission = null; // { chain, hints, elapsedSeconds } awaiting a player name

const el = {
  ladder: document.getElementById("ladder"),
  form: document.getElementById("guessForm"),
  input: document.getElementById("guessInput"),
  feedback: document.getElementById("feedback"),
  winCard: document.getElementById("winCard"),
  winDetail: document.getElementById("winDetail"),
  nextPuzzleNote: document.getElementById("nextPuzzleNote"),
  puzzleLabel: document.getElementById("puzzleLabel"),
  parLabel: document.getElementById("parLabel"),
  streakLabel: document.getElementById("streakLabel"),
  shareBtn: document.getElementById("shareBtn"),
  hintBtn: document.getElementById("hintBtn"),
  hintRow: document.getElementById("hintRow"),
  hintCountLabel: document.getElementById("hintCountLabel"),
  adBackdrop: document.getElementById("adBackdrop"),
  hintWarningBackdrop: document.getElementById("hintWarningBackdrop"),
  hintWarningCancel: document.getElementById("hintWarningCancel"),
  hintWarningConfirm: document.getElementById("hintWarningConfirm"),
  adCountdownText: document.getElementById("adCountdownText"),
  helpBtn: document.getElementById("helpBtn"),
  helpBackdrop: document.getElementById("helpBackdrop"),
  closeHelp: document.getElementById("closeHelp"),
  tabDaily: document.getElementById("tabDaily"),
  tabPractice: document.getElementById("tabPractice"),
  difficultyRow: document.getElementById("difficultyRow"),
  newPuzzleBtn: document.getElementById("newPuzzleBtn"),
  playAgainBtn: document.getElementById("playAgainBtn"),
  diffBtns: Array.from(document.querySelectorAll(".diff-btn")),
  leaderboardBtn: document.getElementById("leaderboardBtn"),
  leaderboardBackdrop: document.getElementById("leaderboardBackdrop"),
  leaderboardBody: document.getElementById("leaderboardBody"),
  closeLeaderboard: document.getElementById("closeLeaderboard"),
  lbTabTime: document.getElementById("lbTabTime"),
  lbTabSteps: document.getElementById("lbTabSteps"),
  nameBackdrop: document.getElementById("nameBackdrop"),
  nameInput: document.getElementById("nameInput"),
  nameSubmit: document.getElementById("nameSubmit"),
  nameSkip: document.getElementById("nameSkip"),
  statsBtn: document.getElementById("statsBtn"),
  statsBackdrop: document.getElementById("statsBackdrop"),
  statsBody: document.getElementById("statsBody"),
  closeStats: document.getElementById("closeStats"),
  tabArchive: document.getElementById("tabArchive"),
  archiveRow: document.getElementById("archiveRow"),
  chooseDayBtn: document.getElementById("chooseDayBtn"),
  archiveBackdrop: document.getElementById("archiveBackdrop"),
  archiveList: document.getElementById("archiveList"),
  closeArchive: document.getElementById("closeArchive"),
  undoBtn: document.getElementById("undoBtn"),
  parRoute: document.getElementById("parRoute"),
  nameTitle: document.getElementById("nameTitle"),
  nameError: document.getElementById("nameError"),
  nameLabel: document.getElementById("nameLabel"),
  changeNameBtn: document.getElementById("changeNameBtn"),
  reminderRow: document.getElementById("reminderRow"),
  reminderToggle: document.getElementById("reminderToggle"),
  reminderTime: document.getElementById("reminderTime"),
  reminderError: document.getElementById("reminderError"),
};

function currentPuzzle() {
  if (mode === "daily") return daily.puzzle;
  if (mode === "archive") return archive.puzzle;
  return practice;
}

function getPlayerId() {
  let id = localStorage.getItem("rungs:playerId");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2)));
    localStorage.setItem("rungs:playerId", id);
  }
  return id;
}

function getPlayerName() {
  return localStorage.getItem("rungs:playerName");
}

function setPlayerName(name) {
  localStorage.setItem("rungs:playerName", name);
}

// Archive replays share the day's key, so a day you half-played on the day
// resumes where you left off, and a day you already solved shows as solved.
function storageKey() {
  if (mode === "daily") return "rungs:daily:" + daily.idx;
  if (mode === "archive") return "rungs:daily:" + archive.idx;
  return "rungs:practice";
}

// Restores chain/won progress for whichever puzzle is already current. Does
// NOT touch `practice` itself — callers that want a specific (e.g. freshly
// generated) puzzle must set it before calling this.
function loadProgress() {
  chain = [currentPuzzle().start];
  won = false;
  hintCount = 0;
  hintPosition = null;
  startedAt = Date.now();
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) { saveProgress(); return; }
    const saved = JSON.parse(raw);
    if (saved.chain && saved.chain[0] === currentPuzzle().start) {
      chain = saved.chain;
      won = saved.won;
      hintCount = saved.hintCount || 0;
      startedAt = saved.startedAt || startedAt;
    } else {
      saveProgress();
    }
  } catch (e) { /* ignore corrupt storage */ }
}

// Only used when entering practice mode with no puzzle in memory yet, to
// resume the last saved practice puzzle across a tab switch or reload.
function loadStoredPracticePuzzle() {
  try {
    const raw = localStorage.getItem("rungs:practice");
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.puzzle && saved.puzzle.start && saved.puzzle.end) return saved.puzzle;
  } catch (e) { /* ignore corrupt storage */ }
  return null;
}

function saveProgress() {
  try {
    let payload;
    if (mode === "practice") {
      payload = { puzzle: practice, chain, won, hintCount, startedAt };
    } else {
      payload = { chain, won, hintCount, startedAt, par: currentPuzzle().par };
      // viaArchive marks a day finished after the fact, so it can never
      // count toward a streak.
      if (mode === "archive") payload.viaArchive = true;
    }
    localStorage.setItem(storageKey(), JSON.stringify(payload));
  } catch (e) { /* storage unavailable, fine */ }
}

const DIST_KEYS = ["par", "p1", "p2", "p3", "p4"]; // at par, +1, +2, +3, +4 or more

function getStats() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("rungs:stats")); } catch (e) { /* corrupt */ }
  const dist = {};
  DIST_KEYS.forEach(k => { dist[k] = (s && s.dailyDist && s.dailyDist[k]) || 0; });
  return {
    dailyCompleted: (s && s.dailyCompleted) || 0,
    dailyHints: (s && s.dailyHints) || 0,
    practiceCompleted: (s && s.practiceCompleted) || 0,
    practiceHints: (s && s.practiceHints) || 0,
    archiveCompleted: (s && s.archiveCompleted) || 0,
    archiveHints: (s && s.archiveHints) || 0,
    dailyDist: dist,
  };
}

function saveStats(stats) {
  try { localStorage.setItem("rungs:stats", JSON.stringify(stats)); } catch (e) { /* fine */ }
}

function bumpStat(key) {
  const stats = getStats();
  stats[key] = (stats[key] || 0) + 1;
  saveStats(stats);
}

function recordDailyResult(steps, par) {
  const stats = getStats();
  const over = Math.max(0, steps - par);
  stats.dailyDist[DIST_KEYS[Math.min(over, 4)]]++;
  saveStats(stats);
}

function dailyEntry(idx) {
  try { return JSON.parse(localStorage.getItem("rungs:daily:" + idx)); } catch (e) { return null; }
}

function wonOnTheDay(idx) {
  const e = dailyEntry(idx);
  return !!(e && e.won && !e.viaArchive);
}

// Worked out from saved daily results rather than a stored counter, so a
// missed day really does break the streak.
function getStreaks() {
  let current = 0;
  for (let i = wonOnTheDay(daily.idx) ? daily.idx : daily.idx - 1; i >= 0 && wonOnTheDay(i); i--) current++;
  let best = 0, run = 0;
  for (let d = 0; d <= daily.idx; d++) {
    run = wonOnTheDay(d) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return { current, best };
}

function render() {
  const puzzle = currentPuzzle();
  const GOAL = puzzle.end;
  const PAR = puzzle.par;

  el.tabDaily.setAttribute("aria-selected", String(mode === "daily"));
  el.tabPractice.setAttribute("aria-selected", String(mode === "practice"));
  el.tabArchive.setAttribute("aria-selected", String(mode === "archive"));
  el.difficultyRow.hidden = mode !== "practice";
  el.archiveRow.hidden = mode !== "archive";
  el.diffBtns.forEach(b => b.classList.toggle("is-active", b.dataset.diff === difficulty));

  if (mode === "daily") {
    el.puzzleLabel.textContent = "Daily #" + (daily.idx + 1);
  } else if (mode === "archive") {
    el.puzzleLabel.textContent = "Daily #" + (archive.idx + 1) + " · " + dayDateLabel(archive.idx);
  } else {
    el.puzzleLabel.textContent = "Practice · " + DIFFICULTIES[difficulty].label;
  }
  el.parLabel.textContent = "Par " + PAR;
  el.streakLabel.textContent = "Streak: " + getStreaks().current;

  el.hintCountLabel.textContent = hintCount > 0
    ? hintCount + " hint" + (hintCount === 1 ? "" : "s") + " used"
    : "";
  el.hintBtn.disabled = won;

  const onPath = effectivePathIndices(chain);
  el.undoBtn.disabled = won || onPath.length < 2;

  el.ladder.innerHTML = "";

  const onPathSet = new Set(onPath);
  chain.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "rung";
    if (i === 0) row.classList.add("is-start");
    if (word === GOAL) row.classList.add("is-solved");
    const isLatest = i === chain.length - 1 && word !== GOAL;
    if (isLatest) row.classList.add("is-latest");
    if (!onPathSet.has(i)) row.classList.add("is-backtracked");

    word.split("").forEach((ch, ti) => {
      const tile = document.createElement("span");
      tile.className = "tile";
      if (isLatest && !won && hintPosition === ti) tile.classList.add("is-hint-letter");
      tile.textContent = ch;
      row.appendChild(tile);
    });
    const tag = document.createElement("span");
    tag.className = "rung-tag";
    tag.textContent = i === 0 ? "start" : (word === GOAL ? "goal reached" : "");
    row.appendChild(tag);

    el.ladder.appendChild(row);
  });

  if (!won) {
    const goalRow = document.createElement("div");
    goalRow.className = "rung is-goal";
    for (const ch of GOAL) {
      const tile = document.createElement("span");
      tile.className = "tile";
      tile.textContent = ch;
      goalRow.appendChild(tile);
    }
    const tag = document.createElement("span");
    tag.className = "rung-tag";
    tag.textContent = "goal";
    goalRow.appendChild(tag);
    el.ladder.appendChild(goalRow);
  }

  el.form.hidden = won;
  el.hintRow.hidden = won;
  el.playAgainBtn.hidden = !won || mode === "daily";
  el.playAgainBtn.textContent = mode === "archive" ? "📅 Play another day" : "🔄 New puzzle";

  if (won) {
    el.winCard.hidden = false;
    const steps = chain.length - 1;
    const hintPart = hintCount > 0 ? " · " + hintCount + " hint" + (hintCount === 1 ? "" : "s") : "";
    // Par is the shortest possible route, so matching it is the best result.
    el.winDetail.textContent = steps + " step" + (steps === 1 ? "" : "s") +
      " · par " + PAR + (steps <= PAR ? " · perfect!" : "") + hintPart;
    const route = steps > PAR ? cachedShortestPath(puzzle) : null;
    el.parRoute.hidden = !route;
    if (route) el.parRoute.textContent = "Shortest route: " + route.join(" → ");
    el.leaderboardBtn.hidden = mode !== "daily";
    if (mode === "daily") {
      const now = new Date();
      const nextUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const hoursLeft = Math.max(1, Math.ceil((nextUtcMidnight - now.getTime()) / 3600000));
      el.nextPuzzleNote.textContent = "Next puzzle in about " + hoursLeft + "h (midnight UTC)";
      el.nextPuzzleNote.hidden = false;
    } else {
      el.nextPuzzleNote.hidden = true;
    }
  } else {
    el.winCard.hidden = true;
  }
}

let _routeCache = { key: null, route: null };
function cachedShortestPath(puzzle) {
  const key = puzzle.start + ">" + puzzle.end;
  if (_routeCache.key !== key) _routeCache = { key, route: shortestPath(puzzle.start, puzzle.end) };
  return _routeCache.route;
}

// Vibration API no-ops silently where unsupported (desktop browsers, iOS
// Safari), so this is safe to call unconditionally.
function celebrateWin() {
  const card = el.winCard;
  card.classList.remove("is-popping");
  void card.offsetWidth; // force reflow so the animation restarts every win
  card.classList.add("is-popping");
  if (navigator.vibrate) navigator.vibrate([40, 30, 60]);
}

function diffByOne(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}

function setFeedback(msg) {
  el.feedback.textContent = msg;
}

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (won) return;

  const guess = el.input.value.trim().toUpperCase();
  const last = chain[chain.length - 1];

  if (guess.length !== last.length) {
    setFeedback("Word must be " + last.length + " letters.");
    return;
  }
  if (!diffByOne(last, guess)) {
    setFeedback("Change exactly one letter from " + last + ".");
    return;
  }
  if (!WORDS.has(guess)) {
    setFeedback(guess + " isn't a valid word.");
    return;
  }

  el.input.value = "";
  addStep(guess);
});

function addStep(word) {
  chain.push(word);
  setFeedback("");
  hintPosition = null; // stale now that the word it pointed at is behind us

  if (word === currentPuzzle().end) {
    won = true;
    if (mode === "daily") {
      submitDailyScore();
      bumpStat("dailyCompleted");
      recordDailyResult(chain.length - 1, currentPuzzle().par);
    } else if (mode === "archive") {
      bumpStat("archiveCompleted");
    } else {
      bumpStat("practiceCompleted");
    }
  }
  saveProgress();
  if (won && mode === "daily") scheduleReminders();
  render();
  if (won) celebrateWin();
}

// Undo = stepping back onto the previous word of your current route. It's
// recorded as a real step (same as typing that word again), which keeps the
// fewest-steps leaderboard honest and needs nothing special on the server.
el.undoBtn.addEventListener("click", () => {
  if (won) return;
  const onPath = effectivePathIndices(chain);
  if (onPath.length < 2) return;
  addStep(chain[onPath[onPath.length - 2]]);
});

function submitDailyScore() {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const name = getPlayerName();
  if (name === null) {
    pendingSubmission = { chain: chain.slice(), hints: hintCount, elapsedSeconds };
    openNamePrompt(false);
    return;
  }
  sendScore(name, chain.slice(), hintCount, elapsedSeconds);
}

function sendScore(name, chainArr, hints, elapsedSeconds) {
  fetch(API_BASE + "/api/leaderboard/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: getPlayerId(), name, chain: chainArr, hints, elapsedSeconds }),
  }).then(r => r.json()).then(res => {
    // The server has the final say on names (e.g. one saved before the filter
    // existed). It lists you as Anonymous, and we ask again next time.
    if (res && res.nameRejected) {
      localStorage.removeItem("rungs:playerName");
      setFeedback("That name isn't allowed on the leaderboard, so you're listed as Anonymous today.");
    }
  }).catch(() => { /* best-effort; a failed submit shouldn't break the win screen */ });
}

function resolvePlayerName(rawInput) {
  const trimmed = (rawInput || "").trim().slice(0, 24);
  return trimmed || "Anonymous";
}

// true/false from the server; null if it couldn't be reached, in which case
// we accept the name locally — the server still filters it on submit.
async function isNameAllowedRemote(name) {
  try {
    const res = await fetch(API_BASE + "/api/name/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    return typeof data.allowed === "boolean" ? data.allowed : null;
  } catch (e) {
    return null;
  }
}

let renamingOnly = false; // true when opened from stats, with no score waiting

function openNamePrompt(rename) {
  renamingOnly = rename;
  const current = getPlayerName();
  el.nameTitle.textContent = rename ? "Change your leaderboard name" : "Name for the leaderboard?";
  el.nameInput.value = rename && current && current !== "Anonymous" ? current : "";
  el.nameSkip.textContent = rename ? "Cancel" : "Skip";
  el.nameError.hidden = true;
  el.nameBackdrop.hidden = false;
}

function finishNamePrompt(name) {
  setPlayerName(name);
  el.nameBackdrop.hidden = true;
  if (pendingSubmission) {
    sendScore(name, pendingSubmission.chain, pendingSubmission.hints, pendingSubmission.elapsedSeconds);
    pendingSubmission = null;
  }
  if (!el.statsBackdrop.hidden) renderStats();
}

el.nameSubmit.addEventListener("click", async () => {
  const name = resolvePlayerName(el.nameInput.value);
  if (name !== "Anonymous") {
    el.nameSubmit.disabled = true;
    const allowed = await isNameAllowedRemote(name);
    el.nameSubmit.disabled = false;
    if (allowed === false) {
      el.nameError.textContent = "That name isn't allowed. Please pick another.";
      el.nameError.hidden = false;
      return;
    }
  }
  finishNamePrompt(name);
});
el.nameSkip.addEventListener("click", () => {
  if (renamingOnly) { el.nameBackdrop.hidden = true; return; }
  finishNamePrompt("Anonymous");
});
el.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.nameSubmit.click();
});
el.changeNameBtn.addEventListener("click", () => openNamePrompt(true));

function formatTime(s) {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m + ":" + String(r).padStart(2, "0");
}

let leaderboardData = null;
let leaderboardTab = "time"; // "time" or "steps"

function renderLeaderboard(data) {
  el.leaderboardBody.innerHTML = "";
  const addLine = (text) => {
    const p = document.createElement("p");
    p.className = "help-text";
    p.textContent = text;
    el.leaderboardBody.appendChild(p);
  };
  addLine(data.first
    ? "First to solve: " + data.first.name + (data.first.isMe ? " (you!)" : "")
    : "Nobody's solved it yet today.");

  const bySteps = leaderboardTab === "steps";
  el.lbTabTime.setAttribute("aria-selected", String(!bySteps));
  el.lbTabSteps.setAttribute("aria-selected", String(bySteps));

  const describe = r => bySteps
    ? r.steps + " steps (" + formatTime(r.timeSeconds) + ")"
    : formatTime(r.timeSeconds) + " (" + r.steps + " steps)";

  const ranked = (bySteps ? data.bySteps : data.ranked) || [];
  addLine(bySteps ? "Fewest steps (no hints)" : "Fastest (no hints)");
  const list = document.createElement("ol");
  list.className = "lb-list";
  if (ranked.length === 0) {
    const li = document.createElement("li");
    li.textContent = bySteps ? "No qualifying solves yet." : "No qualifying times yet.";
    list.appendChild(li);
  } else {
    ranked.forEach((r, i) => {
      const li = document.createElement("li");
      li.textContent = (i + 1) + ". " + r.name + (r.isMe ? " (you)" : "") + " — " + describe(r);
      if (r.isMe) li.classList.add("is-me");
      list.appendChild(li);
    });
  }
  el.leaderboardBody.appendChild(list);

  // Your own standing when you didn't make the top 20 shown above.
  const me = data.me;
  if (me && me.hints === 0 && !ranked.some(r => r.isMe)) {
    addLine("You: #" + (bySteps ? me.rankSteps : me.rankTime) + " — " + describe(me));
    el.leaderboardBody.lastChild.classList.add("lb-you");
  }

  if (data.assisted && data.assisted.length) {
    addLine("Assisted (used a hint)");
    const alist = document.createElement("ul");
    alist.className = "lb-list";
    data.assisted.forEach(r => {
      const li = document.createElement("li");
      li.textContent = r.name + (r.isMe ? " (you)" : "") + " — " + formatTime(r.timeSeconds) + " (" + r.steps + " steps)";
      if (r.isMe) li.classList.add("is-me");
      alist.appendChild(li);
    });
    el.leaderboardBody.appendChild(alist);
  }
}

el.lbTabTime.addEventListener("click", () => {
  if (leaderboardTab === "time") return;
  leaderboardTab = "time";
  if (leaderboardData) renderLeaderboard(leaderboardData);
});
el.lbTabSteps.addEventListener("click", () => {
  if (leaderboardTab === "steps") return;
  leaderboardTab = "steps";
  if (leaderboardData) renderLeaderboard(leaderboardData);
});

el.leaderboardBtn.addEventListener("click", async () => {
  el.leaderboardBackdrop.hidden = false;
  el.leaderboardBody.innerHTML = "";
  const p = document.createElement("p");
  p.className = "help-text";
  p.textContent = "Loading…";
  el.leaderboardBody.appendChild(p);
  try {
    const res = await fetch(API_BASE + "/api/leaderboard/today", {
      headers: { "X-Player-Id": getPlayerId() },
    });
    const data = await res.json();
    leaderboardData = data;
    renderLeaderboard(data);
  } catch (e) {
    el.leaderboardBody.innerHTML = "";
    const err = document.createElement("p");
    err.className = "help-text";
    err.textContent = "Couldn't load the leaderboard right now.";
    el.leaderboardBody.appendChild(err);
  }
});
el.closeLeaderboard.addEventListener("click", () => { el.leaderboardBackdrop.hidden = true; });
el.leaderboardBackdrop.addEventListener("click", (e) => {
  if (e.target === el.leaderboardBackdrop) el.leaderboardBackdrop.hidden = true;
});

el.shareBtn.addEventListener("click", () => {
  const puzzle = currentPuzzle();
  const steps = chain.length - 1;
  const diff = steps - puzzle.par;
  const resultTag = diff <= 0 ? "🟢" : diff === 1 ? "🟡" : "🟠";
  const label = mode === "daily" ? "Daily #" + (daily.idx + 1)
    : mode === "archive" ? "Archive #" + (archive.idx + 1)
    : "Practice (" + DIFFICULTIES[difficulty].label + ")";
  const hintPart = hintCount > 0 ? ` · ${hintCount} hint${hintCount === 1 ? "" : "s"}` : "";
  const text = `Rungs ${label} ${resultTag} ${steps}/${puzzle.par} steps${hintPart}\n${puzzle.start} → ${puzzle.end}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => setFeedback("Result copied."));
  } else {
    setFeedback(text);
  }
});

// Google's public test Rewarded Ad unit — always serves test creative, safe
// to ship, never generates real revenue. Swap for the real ad unit ID from
// the user's AdMob account before a production release.
const ADMOB_REWARDED_AD_UNIT_ID = "ca-app-pub-9324750418213634/9797624613";

// window.Capacitor.Plugins is how Capacitor exposes native plugins without a
// bundler (we ship plain <script> tags, no import/build step) — undefined on
// the web build, where there's no native ad SDK at all.
function getAdMobPlugin() {
  return (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() &&
    window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) || null;
}

let adMobReady = false;
// Registers the developer's own phone as an AdMob test device so repeated
// testing never serves (or gets flagged for) real ad impressions, while
// every other device still receives real ads normally.
const ADMOB_TEST_DEVICE_IDS = ["A9F4B72D7573DC1F9C72F186F6E151E7"];

async function ensureAdMobInitialized() {
  const AdMob = getAdMobPlugin();
  if (!AdMob || adMobReady) return;
  try {
    await AdMob.initialize({ testingDevices: ADMOB_TEST_DEVICE_IDS });
    adMobReady = true;
  } catch (e) { /* leave adMobReady false; each hint attempt just retries initialize-adjacent calls */ }
}

// Real ad on native (Capacitor AdMob plugin); simulated countdown on the web,
// since there's no equivalent web ad SDK in scope. Either way, `onComplete`
// only fires once the hint is actually earned.
function showRewardedAd(onComplete) {
  const AdMob = getAdMobPlugin();
  if (AdMob) {
    showRealRewardedAd(AdMob, onComplete);
    return;
  }
  let secs = 3;
  el.adCountdownText.textContent = "Hint in " + secs + "…";
  el.adBackdrop.hidden = false;
  const timer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(timer);
      el.adBackdrop.hidden = true;
      onComplete();
    } else {
      el.adCountdownText.textContent = "Hint in " + secs + "…";
    }
  }, 1000);
}

async function showRealRewardedAd(AdMob, onComplete) {
  el.adCountdownText.textContent = "Loading ad…";
  el.adBackdrop.hidden = false;

  let earned = false;
  let listeners = [];
  const cleanup = () => { listeners.forEach(l => l.remove()); listeners = []; };
  const failClosed = (message) => {
    cleanup();
    el.adBackdrop.hidden = true;
    el.hintBtn.disabled = won;
    setFeedback(message);
  };

  try {
    listeners.push(await AdMob.addListener("onRewardedVideoAdReward", () => { earned = true; }));
    listeners.push(await AdMob.addListener("onRewardedVideoAdDismissed", () => {
      cleanup();
      el.adBackdrop.hidden = true;
      if (earned) {
        onComplete();
      } else {
        el.hintBtn.disabled = won;
        setFeedback("Hint not unlocked — the ad wasn't finished.");
      }
    }));
    listeners.push(await AdMob.addListener("onRewardedVideoAdFailedToLoad", () => {
      failClosed("Couldn't load an ad right now — try again in a moment.");
    }));
    listeners.push(await AdMob.addListener("onRewardedVideoAdFailedToShow", () => {
      failClosed("Couldn't show the ad right now — try again in a moment.");
    }));

    await ensureAdMobInitialized();
    await AdMob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_AD_UNIT_ID, isTesting: false });
    await AdMob.showRewardVideoAd();
  } catch (e) {
    failClosed("Couldn't show the ad right now — try again in a moment.");
  }
}

function startHintFlow() {
  el.hintBtn.disabled = true;
  showRewardedAd(() => {
    const puzzle = currentPuzzle();
    const last = chain[chain.length - 1];
    // Prefer a route that avoids words you've already tried; since words can
    // be reused now, fall back to any shortest route rather than leave the
    // player with nothing after they watched an ad.
    const next = nextHintWord(last, puzzle.end, chain) || nextHintWord(last, puzzle.end, []);
    if (!next) {
      setFeedback("No hint available from here — try backtracking.");
      el.hintBtn.disabled = won;
      return;
    }
    let idx = -1;
    for (let i = 0; i < last.length; i++) {
      if (last[i] !== next[i]) { idx = i; break; }
    }
    hintPosition = idx;
    hintCount++;
    bumpStat(mode === "daily" ? "dailyHints" : mode === "archive" ? "archiveHints" : "practiceHints");
    setFeedback("Hint: look at the highlighted letter.");
    saveProgress();
    render();
  });
}

el.hintBtn.addEventListener("click", () => {
  if (won) return;
  if (mode === "daily") {
    el.hintWarningBackdrop.hidden = false;
    return;
  }
  startHintFlow();
});

el.hintWarningCancel.addEventListener("click", () => { el.hintWarningBackdrop.hidden = true; });
el.hintWarningConfirm.addEventListener("click", () => {
  el.hintWarningBackdrop.hidden = true;
  startHintFlow();
});
el.hintWarningBackdrop.addEventListener("click", (e) => {
  if (e.target === el.hintWarningBackdrop) el.hintWarningBackdrop.hidden = true;
});

el.helpBtn.addEventListener("click", () => { el.helpBackdrop.hidden = false; });
el.closeHelp.addEventListener("click", () => { el.helpBackdrop.hidden = true; });
el.helpBackdrop.addEventListener("click", (e) => {
  if (e.target === el.helpBackdrop) el.helpBackdrop.hidden = true;
});

function renderStats() {
  const s = getStats();
  const streaks = getStreaks();
  el.statsBody.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  [
    [s.dailyCompleted, "Dailies solved"],
    [streaks.current, "Current streak"],
    [streaks.best, "Best streak"],
    [s.practiceCompleted + s.archiveCompleted, "Practice + archive"],
  ].forEach(([num, cap]) => {
    const cell = document.createElement("div");
    cell.className = "stat-cell";
    const n = document.createElement("div");
    n.className = "stat-num";
    n.textContent = num;
    const c = document.createElement("div");
    c.className = "stat-cap";
    c.textContent = cap;
    cell.append(n, c);
    grid.appendChild(cell);
  });
  el.statsBody.appendChild(grid);

  const head = document.createElement("p");
  head.className = "stats-section";
  head.textContent = "Daily steps vs par";
  el.statsBody.appendChild(head);

  const dist = document.createElement("div");
  dist.className = "dist";
  const counts = DIST_KEYS.map(k => s.dailyDist[k]);
  const max = Math.max(1, ...counts);
  ["Par", "+1", "+2", "+3", "+4"].forEach((label, i) => {
    const row = document.createElement("div");
    row.className = "dist-row";
    const l = document.createElement("span");
    l.className = "dist-label";
    l.textContent = label;
    const bar = document.createElement("span");
    bar.className = "dist-bar" + (i === 0 ? " is-par" : "");
    bar.style.width = Math.round((counts[i] / max) * 100) + "%";
    bar.textContent = counts[i];
    row.append(l, bar);
    dist.appendChild(row);
  });
  el.statsBody.appendChild(dist);
  if (s.dailyCompleted > counts.reduce((a, b) => a + b, 0)) {
    const note = document.createElement("p");
    note.className = "stat-cap";
    note.textContent = "Chart counts dailies solved since version 1.1.";
    note.style.margin = "-10px 0 14px";
    el.statsBody.appendChild(note);
  }

  const hints = document.createElement("p");
  hints.className = "help-text";
  hints.textContent = "Hints used: " + s.dailyHints + " daily · " + (s.practiceHints + s.archiveHints) + " practice/archive";
  el.statsBody.appendChild(hints);

  el.nameLabel.textContent = "Leaderboard name: " + (getPlayerName() || "not set");
  renderReminderSettings();
}

el.statsBtn.addEventListener("click", () => { renderStats(); el.statsBackdrop.hidden = false; });
el.closeStats.addEventListener("click", () => { el.statsBackdrop.hidden = true; });
el.statsBackdrop.addEventListener("click", (e) => {
  if (e.target === el.statsBackdrop) el.statsBackdrop.hidden = true;
});

function switchMode(next) {
  if (mode === next) return;
  mode = next;
  if (mode === "practice" && !practice) {
    practice = loadStoredPracticePuzzle() || practicePuzzle(difficulty);
  }
  loadProgress();
  setFeedback("");
  render();
}

el.tabDaily.addEventListener("click", () => switchMode("daily"));
el.tabPractice.addEventListener("click", () => switchMode("practice"));
el.tabArchive.addEventListener("click", () => {
  if (archive) switchMode("archive");
  else openArchivePicker();
});

function openArchivePicker() {
  el.archiveList.innerHTML = "";
  if (daily.idx === 0) {
    const li = document.createElement("li");
    li.className = "help-text";
    li.textContent = "No past dailies yet — check back tomorrow.";
    el.archiveList.appendChild(li);
  }
  for (let idx = daily.idx - 1; idx >= 0; idx--) {
    const entry = dailyEntry(idx);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const label = document.createElement("span");
    label.textContent = "#" + (idx + 1) + " · " + dayDateLabel(idx);
    const status = document.createElement("span");
    status.className = "archive-status";
    if (entry && entry.won) {
      status.textContent = "✓ " + (entry.chain.length - 1) + " steps";
      status.classList.add("is-done");
    } else if (entry && entry.chain && entry.chain.length > 1) {
      status.textContent = "in progress";
    }
    btn.append(label, status);
    btn.addEventListener("click", () => selectArchiveDay(idx));
    li.appendChild(btn);
    el.archiveList.appendChild(li);
  }
  el.archiveBackdrop.hidden = false;
}

function selectArchiveDay(idx) {
  el.archiveBackdrop.hidden = true;
  archive = dailyPuzzleFor(idx);
  mode = "archive";
  loadProgress();
  setFeedback("");
  render();
}

el.chooseDayBtn.addEventListener("click", openArchivePicker);
el.closeArchive.addEventListener("click", () => { el.archiveBackdrop.hidden = true; });
el.archiveBackdrop.addEventListener("click", (e) => {
  if (e.target === el.archiveBackdrop) el.archiveBackdrop.hidden = true;
});

el.diffBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.diff;
    if (next === difficulty && practice) return;
    difficulty = next;
    localStorage.setItem("rungs:difficulty", difficulty);
    practice = practicePuzzle(difficulty);
    if (mode === "practice") {
      loadProgress();
      setFeedback("");
      render();
    } else {
      render(); // just to refresh the active-button highlight
    }
  });
});

function newPracticePuzzle() {
  practice = practicePuzzle(difficulty);
  loadProgress();
  setFeedback("");
  render();
}

el.newPuzzleBtn.addEventListener("click", newPracticePuzzle);
el.playAgainBtn.addEventListener("click", () => {
  if (mode === "archive") openArchivePicker();
  else newPracticePuzzle();
});

// --- Daily reminder (native app only; the web has no local notifications) ---
function getNotificationsPlugin() {
  return (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() &&
    window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
}

function getReminderSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("rungs:reminder"));
    if (s && typeof s.on === "boolean" && /^\d\d:\d\d$/.test(s.time)) return s;
  } catch (e) { /* fall through */ }
  return { on: false, time: "19:00" };
}

function saveReminderSettings(s) {
  try { localStorage.setItem("rungs:reminder", JSON.stringify(s)); } catch (e) { /* fine */ }
}

function renderReminderSettings() {
  el.reminderRow.hidden = !getNotificationsPlugin();
  const s = getReminderSettings();
  el.reminderToggle.checked = s.on;
  el.reminderTime.value = s.time;
}

const REMINDER_IDS = [101, 102, 103, 104, 105, 106, 107];

// Re-plans the next week of reminders every time the app opens, so a day
// you've already solved is skipped, and someone who stops playing gets at
// most a week of nudges rather than reminders forever.
async function scheduleReminders() {
  const LN = getNotificationsPlugin();
  if (!LN) return;
  try {
    await LN.cancel({ notifications: REMINDER_IDS.map(id => ({ id })) });
    const s = getReminderSettings();
    if (!s.on) return;
    const [hh, mm] = s.time.split(":").map(Number);
    const now = Date.now();
    const streak = getStreaks().current;
    const notifications = [];
    for (let d = 0; d < REMINDER_IDS.length; d++) {
      const at = new Date();
      at.setDate(at.getDate() + d);
      at.setHours(hh, mm, 0, 0);
      if (at.getTime() <= now + 60000) continue;
      const idxAt = Math.floor((at.getTime() - EPOCH.getTime()) / 86400000);
      if (wonOnTheDay(idxAt)) continue;
      const body = notifications.length === 0 && streak > 0
        ? "Keep your " + streak + "-day streak alive. Today's ladder is ready."
        : "Today's word ladder is ready. Can you match par?";
      notifications.push({
        id: REMINDER_IDS[d], title: "Rungs", body,
        schedule: { at, allowWhileIdle: true },
        // A reminder a few minutes late is fine; exact alarms would send the
        // player to a system settings screen on Android 12+.
        isExactNotification: false,
        autoCancel: true,
      });
    }
    if (notifications.length) await LN.schedule({ notifications });
  } catch (e) { /* notifications are a nicety; never break the game over them */ }
}

el.reminderToggle.addEventListener("change", async () => {
  const LN = getNotificationsPlugin();
  const s = getReminderSettings();
  el.reminderError.hidden = true;
  if (el.reminderToggle.checked && LN) {
    let perm = null;
    try { perm = await LN.requestPermissions(); } catch (e) { /* treated as denied */ }
    if (!perm || perm.display !== "granted") {
      el.reminderToggle.checked = false;
      el.reminderError.textContent = "Notifications are turned off for Rungs in your phone's settings.";
      el.reminderError.hidden = false;
      return;
    }
  }
  s.on = el.reminderToggle.checked;
  saveReminderSettings(s);
  scheduleReminders();
});

el.reminderTime.addEventListener("change", () => {
  if (!/^\d\d:\d\d$/.test(el.reminderTime.value)) return;
  const s = getReminderSettings();
  s.time = el.reminderTime.value;
  saveReminderSettings(s);
  scheduleReminders();
});

// The app can sit in the background across midnight UTC; pick up the new
// daily (and refresh reminders) when it comes back to the foreground.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (dayIndex() !== daily.idx) {
    daily = dailyPuzzle();
    if (mode === "daily") { loadProgress(); setFeedback(""); }
    render();
  }
  scheduleReminders();
});

loadProgress();
render();
ensureAdMobInitialized();
scheduleReminders();

if (!localStorage.getItem("rungs:seenHelp")) {
  localStorage.setItem("rungs:seenHelp", "1");
  el.helpBackdrop.hidden = false;
}
