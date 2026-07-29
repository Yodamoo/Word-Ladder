// script.js — Rungs game engine

const EPOCH = new Date("2026-07-27T00:00:00");

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
  const rng = mulberry32(idx + 1); // +1 so seed 0 isn't degenerate
  return { idx, puzzle: generatePuzzle(rng, DAILY_LENGTHS, DAILY_PAR_RANGE) };
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

const el = {
  ladder: document.getElementById("ladder"),
  form: document.getElementById("guessForm"),
  input: document.getElementById("guessInput"),
  feedback: document.getElementById("feedback"),
  winCard: document.getElementById("winCard"),
  winDetail: document.getElementById("winDetail"),
  puzzleLabel: document.getElementById("puzzleLabel"),
  parLabel: document.getElementById("parLabel"),
  streakLabel: document.getElementById("streakLabel"),
  shareBtn: document.getElementById("shareBtn"),
  adFillBtn: document.getElementById("adFillBtn"),
  helpBtn: document.getElementById("helpBtn"),
  helpBackdrop: document.getElementById("helpBackdrop"),
  closeHelp: document.getElementById("closeHelp"),
  tabDaily: document.getElementById("tabDaily"),
  tabPractice: document.getElementById("tabPractice"),
  difficultyRow: document.getElementById("difficultyRow"),
  newPuzzleBtn: document.getElementById("newPuzzleBtn"),
  diffBtns: Array.from(document.querySelectorAll(".diff-btn")),
};

function currentPuzzle() {
  return mode === "daily" ? daily.puzzle : practice;
}

function storageKey() {
  return mode === "daily" ? "rungs:daily:" + daily.idx : "rungs:practice";
}

function loadProgress() {
  chain = [currentPuzzle().start];
  won = false;
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (mode === "practice") {
      if (saved.puzzle && saved.puzzle.start && saved.puzzle.end) {
        practice = saved.puzzle;
      }
    }
    if (saved.chain && saved.chain[0] === currentPuzzle().start) {
      chain = saved.chain;
      won = saved.won;
    }
  } catch (e) { /* ignore corrupt storage */ }
}

function saveProgress() {
  try {
    const payload = mode === "practice"
      ? { puzzle: practice, chain, won }
      : { chain, won };
    localStorage.setItem(storageKey(), JSON.stringify(payload));
  } catch (e) { /* storage unavailable, fine */ }
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

  el.ladder.innerHTML = "";

  chain.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "rung";
    if (i === 0) row.classList.add("is-start");
    if (word === GOAL) row.classList.add("is-solved");
    if (i === chain.length - 1 && word !== GOAL) row.classList.add("is-latest");

    for (const ch of word) {
      const tile = document.createElement("span");
      tile.className = "tile";
      tile.textContent = ch;
      row.appendChild(tile);
    }
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

  el.form.querySelector("input").disabled = won;
  el.form.querySelector("button").disabled = won;

  if (won) {
    el.winCard.hidden = false;
    const steps = chain.length - 1;
    el.winDetail.textContent = steps + " step" + (steps === 1 ? "" : "s") +
      " · par " + PAR + (steps <= PAR ? " · under par" : "");
  } else {
    el.winCard.hidden = true;
  }
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
    setFeedback(guess + " isn't in the word list yet.");
    return;
  }
  if (chain.includes(guess)) {
    setFeedback("Already used that word.");
    return;
  }

  chain.push(guess);
  el.input.value = "";
  setFeedback("");

  if (guess === currentPuzzle().end) {
    won = true;
    if (mode === "daily") bumpStreak();
  }
  saveProgress();
  render();
});

el.shareBtn.addEventListener("click", () => {
  const puzzle = currentPuzzle();
  const steps = chain.length - 1;
  const diff = steps - puzzle.par;
  const resultTag = diff <= 0 ? "🟢" : diff === 1 ? "🟡" : "🟠";
  const label = mode === "daily" ? "Daily #" + (daily.idx + 1) : "Practice (" + DIFFICULTIES[difficulty].label + ")";
  const text = `Rungs ${label} ${resultTag} ${steps}/${puzzle.par} steps\n${puzzle.start} → ${puzzle.end}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => setFeedback("Result copied."));
  } else {
    setFeedback(text);
  }
});

el.adFillBtn.addEventListener("click", () => {
  setFeedback("Demo only — in the real app this plays a short rewarded video, then reveals one hint letter.");
});

el.helpBtn.addEventListener("click", () => { el.helpBackdrop.hidden = false; });
el.closeHelp.addEventListener("click", () => { el.helpBackdrop.hidden = true; });
el.helpBackdrop.addEventListener("click", (e) => {
  if (e.target === el.helpBackdrop) el.helpBackdrop.hidden = true;
});

function switchMode(next) {
  if (mode === next) return;
  mode = next;
  if (mode === "practice" && !practice) {
    practice = practicePuzzle(difficulty);
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

el.newPuzzleBtn.addEventListener("click", () => {
  practice = practicePuzzle(difficulty);
  loadProgress();
  setFeedback("");
  render();
});

loadProgress();
render();
