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

function dailyPuzzle() {
  const idx = dayIndex();
  // Fallback keeps the page playable if generation ever fails; the server
  // won't rank that puzzle, but a playable game beats a blank screen.
  const puzzle = generateDailyPuzzle(idx)
    || generatePuzzle(mulberry32(idx + 1), DAILY_LENGTHS, DAILY_PAR_RANGE);
  return { idx, puzzle };
}

function practicePuzzle(difficulty) {
  const rng = mulberry32(Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF));
  const tier = DIFFICULTIES[difficulty];
  return generatePuzzle(rng, tier.lengths, tier.parRange);
}

// --- Game state ---
let mode = "daily"; // "daily" | "practice"
let difficulty = localStorage.getItem("rungs:difficulty") || "medium";
let daily = dailyPuzzle();
let practice = null; // { start, end, par }
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
};

function currentPuzzle() {
  return mode === "daily" ? daily.puzzle : practice;
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

function storageKey() {
  return mode === "daily" ? "rungs:daily:" + daily.idx : "rungs:practice";
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
    const payload = mode === "practice"
      ? { puzzle: practice, chain, won, hintCount, startedAt }
      : { chain, won, hintCount, startedAt };
    localStorage.setItem(storageKey(), JSON.stringify(payload));
  } catch (e) { /* storage unavailable, fine */ }
}

function getStats() {
  try {
    const s = JSON.parse(localStorage.getItem("rungs:stats"));
    return {
      dailyCompleted: (s && s.dailyCompleted) || 0,
      dailyHints: (s && s.dailyHints) || 0,
      practiceCompleted: (s && s.practiceCompleted) || 0,
      practiceHints: (s && s.practiceHints) || 0,
    };
  } catch (e) {
    return { dailyCompleted: 0, dailyHints: 0, practiceCompleted: 0, practiceHints: 0 };
  }
}

function bumpStat(key) {
  const stats = getStats();
  stats[key] = (stats[key] || 0) + 1;
  localStorage.setItem("rungs:stats", JSON.stringify(stats));
}

function getStreak() {
  return parseInt(localStorage.getItem("rungs:streak") || "0", 10);
}

function bumpStreak() {
  const lastWin = localStorage.getItem("rungs:lastWinIndex");
  if (lastWin === String(daily.idx)) return; // already counted today
  const streak = getStreak() + 1;
  localStorage.setItem("rungs:streak", String(streak));
  localStorage.setItem("rungs:lastWinIndex", String(daily.idx));
}

function render() {
  const puzzle = currentPuzzle();
  const GOAL = puzzle.end;
  const PAR = puzzle.par;

  el.tabDaily.setAttribute("aria-selected", String(mode === "daily"));
  el.tabPractice.setAttribute("aria-selected", String(mode === "practice"));
  el.difficultyRow.hidden = mode !== "practice";
  el.diffBtns.forEach(b => b.classList.toggle("is-active", b.dataset.diff === difficulty));

  if (mode === "daily") {
    el.puzzleLabel.textContent = "Daily #" + (daily.idx + 1);
  } else {
    el.puzzleLabel.textContent = "Practice · " + DIFFICULTIES[difficulty].label;
  }
  el.parLabel.textContent = "Par " + PAR;
  el.streakLabel.textContent = "Streak: " + getStreak();

  el.hintCountLabel.textContent = hintCount > 0
    ? hintCount + " hint" + (hintCount === 1 ? "" : "s") + " used"
    : "";
  el.hintBtn.disabled = won;

  el.ladder.innerHTML = "";

  chain.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "rung";
    if (i === 0) row.classList.add("is-start");
    if (word === GOAL) row.classList.add("is-solved");
    const isLatest = i === chain.length - 1 && word !== GOAL;
    if (isLatest) row.classList.add("is-latest");

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
  el.playAgainBtn.hidden = !won || mode !== "practice";

  if (won) {
    el.winCard.hidden = false;
    const steps = chain.length - 1;
    const hintPart = hintCount > 0 ? " · " + hintCount + " hint" + (hintCount === 1 ? "" : "s") : "";
    el.winDetail.textContent = steps + " step" + (steps === 1 ? "" : "s") +
      " · par " + PAR + (steps <= PAR ? " · under par" : "") + hintPart;
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

  chain.push(guess);
  el.input.value = "";
  setFeedback("");
  hintPosition = null; // stale now that the word it pointed at is behind us

  if (guess === currentPuzzle().end) {
    won = true;
    if (mode === "daily") {
      bumpStreak();
      submitDailyScore();
      bumpStat("dailyCompleted");
    } else {
      bumpStat("practiceCompleted");
    }
  }
  saveProgress();
  render();
  if (won) celebrateWin();
});

function submitDailyScore() {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const name = getPlayerName();
  if (name === null) {
    pendingSubmission = { chain: chain.slice(), hints: hintCount, elapsedSeconds };
    el.nameInput.value = "";
    el.nameBackdrop.hidden = false;
    return;
  }
  sendScore(name, chain.slice(), hintCount, elapsedSeconds);
}

function sendScore(name, chainArr, hints, elapsedSeconds) {
  fetch(API_BASE + "/api/leaderboard/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: getPlayerId(), name, chain: chainArr, hints, elapsedSeconds }),
  }).catch(() => { /* best-effort; a failed submit shouldn't break the win screen */ });
}

function resolvePlayerName(rawInput) {
  const trimmed = (rawInput || "").trim().slice(0, 24);
  return trimmed || "Anonymous";
}

el.nameSubmit.addEventListener("click", () => {
  const name = resolvePlayerName(el.nameInput.value);
  setPlayerName(name);
  el.nameBackdrop.hidden = true;
  if (pendingSubmission) {
    sendScore(name, pendingSubmission.chain, pendingSubmission.hints, pendingSubmission.elapsedSeconds);
    pendingSubmission = null;
  }
});
el.nameSkip.addEventListener("click", () => {
  const name = "Anonymous";
  setPlayerName(name);
  el.nameBackdrop.hidden = true;
  if (pendingSubmission) {
    sendScore(name, pendingSubmission.chain, pendingSubmission.hints, pendingSubmission.elapsedSeconds);
    pendingSubmission = null;
  }
});

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
  addLine(data.first ? "First to solve: " + data.first.name : "Nobody's solved it yet today.");

  const bySteps = leaderboardTab === "steps";
  el.lbTabTime.setAttribute("aria-selected", String(!bySteps));
  el.lbTabSteps.setAttribute("aria-selected", String(bySteps));

  const ranked = (bySteps ? data.bySteps : data.ranked) || [];
  addLine(bySteps ? "Fewest steps (no hints)" : "Fastest (no hints)");
  const list = document.createElement("ol");
  list.className = "lb-list";
  if (ranked.length === 0) {
    const li = document.createElement("li");
    li.textContent = bySteps ? "No qualifying solves yet." : "No qualifying times yet.";
    list.appendChild(li);
  } else {
    ranked.forEach(r => {
      const li = document.createElement("li");
      li.textContent = bySteps
        ? r.name + " — " + r.steps + " steps (" + formatTime(r.timeSeconds) + ")"
        : r.name + " — " + formatTime(r.timeSeconds) + " (" + r.steps + " steps)";
      list.appendChild(li);
    });
  }
  el.leaderboardBody.appendChild(list);
  if (data.assisted && data.assisted.length) {
    addLine("Assisted (used a hint)");
    const alist = document.createElement("ul");
    alist.className = "lb-list";
    data.assisted.forEach(r => {
      const li = document.createElement("li");
      li.textContent = r.name + " — " + formatTime(r.timeSeconds) + " (" + r.steps + " steps)";
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
    const res = await fetch(API_BASE + "/api/leaderboard/today");
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
  const label = mode === "daily" ? "Daily #" + (daily.idx + 1) : "Practice (" + DIFFICULTIES[difficulty].label + ")";
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
    const next = nextHintWord(last, puzzle.end, chain);
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
    bumpStat(mode === "daily" ? "dailyHints" : "practiceHints");
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
  el.statsBody.innerHTML = "";
  [
    ["Daily puzzles solved", s.dailyCompleted],
    ["Daily hints used", s.dailyHints],
    ["Practice puzzles solved", s.practiceCompleted],
    ["Practice hints used", s.practiceHints],
  ].forEach(([label, val]) => {
    const p = document.createElement("p");
    p.className = "help-text";
    p.textContent = label + ": " + val;
    el.statsBody.appendChild(p);
  });
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
el.playAgainBtn.addEventListener("click", newPracticePuzzle);

loadProgress();
render();
ensureAdMobInitialized();

if (!localStorage.getItem("rungs:seenHelp")) {
  localStorage.setItem("rungs:seenHelp", "1");
  el.helpBackdrop.hidden = false;
}
