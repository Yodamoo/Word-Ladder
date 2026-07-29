// script.js — Rungs game engine

const EPOCH = new Date("2026-07-27T00:00:00");

function puzzleIndexForToday() {
  const now = new Date();
  const days = Math.floor((now - EPOCH) / 86400000);
  return ((days % PUZZLES.length) + PUZZLES.length) % PUZZLES.length;
}

const puzzleIndex = puzzleIndexForToday();
const PUZZLE = PUZZLES[puzzleIndex];
const START = PUZZLE.start;
const GOAL = PUZZLE.end;
const PAR = PUZZLE.par;

let chain = [START];
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
};

function loadProgress() {
  try {
    const raw = localStorage.getItem("rungs:" + puzzleIndex);
    if (!raw) return;
    const saved = JSON.parse(raw);
    chain = saved.chain;
    won = saved.won;
  } catch (e) { /* ignore corrupt storage */ }
}

function saveProgress() {
  try {
    localStorage.setItem("rungs:" + puzzleIndex, JSON.stringify({ chain, won }));
  } catch (e) { /* storage unavailable, fine */ }
}

function getStreak() {
  return parseInt(localStorage.getItem("rungs:streak") || "0", 10);
}

function bumpStreak() {
  const lastWin = localStorage.getItem("rungs:lastWinIndex");
  if (lastWin === String(puzzleIndex)) return; // already counted today
  const streak = getStreak() + 1;
  localStorage.setItem("rungs:streak", String(streak));
  localStorage.setItem("rungs:lastWinIndex", String(puzzleIndex));
}

function render() {
  el.puzzleLabel.textContent = "Puzzle #" + (puzzleIndex + 1);
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

  if (won) {
    el.winCard.hidden = false;
    const steps = chain.length - 1;
    el.winDetail.textContent = steps + " step" + (steps === 1 ? "" : "s") +
      " · par " + PAR + (steps <= PAR ? " · under par" : "");
    el.form.querySelector("input").disabled = true;
    el.form.querySelector("button").disabled = true;
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

  if (guess === GOAL) {
    won = true;
    bumpStreak();
  }
  saveProgress();
  render();
});

el.shareBtn.addEventListener("click", () => {
  const steps = chain.length - 1;
  const diff = steps - PAR;
  const resultTag = diff <= 0 ? "🟢" : diff === 1 ? "🟡" : "🟠";
  const text = `Rungs #${puzzleIndex + 1} ${resultTag} ${steps}/${PAR} steps\n${START} → ${GOAL}`;
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

loadProgress();
render();
