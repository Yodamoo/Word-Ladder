# Rungs — a daily word ladder game

A working prototype of a Wordle-style daily word ladder game. Turn the
start word into the goal word, one letter at a time, using only real words.

## What's here

- `index.html` / `style.css` / `script.js` / `words.js` — a complete,
  playable, static web app. No build step, no server. Open `index.html`
  in a browser and it runs.
- 7 hand-verified puzzles that rotate by date (same puzzle for everyone,
  each day, like Wordle).
- Streak tracking and a "copy result" share button (stored in
  `localStorage`, on-device only for now).
- A placeholder "watch a hint ad" button, wired up but not connected to
  a real ad network yet — see below.

## How to try it

Open `index.html` directly in any browser, or serve the folder locally:

```bash
cd word-ladder
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Next steps, roughly in order

1. **Expand the dictionary.** Right now `words.js` has ~250 hand-picked
   words — enough to make the 7 curated puzzles work, not enough for a
   real product. Swap in a full free word list (e.g. the SCOWL or ENABLE
   word lists) and re-run the validation check below whenever you add
   puzzles.

2. **Generate more puzzles automatically.** Once you have a full
   dictionary, a short script can build a graph where words are
   connected if they differ by one letter, then use breadth-first search
   to both find the shortest path between two words (that's your "par")
   and to mine good start/end pairs automatically instead of curating
   them by hand.

3. **Turn it into an installable app.** The game is currently a plain
   web page. The most beginner-friendly path from here is
   [Capacitor](https://capacitorjs.com/), which wraps a web app like
   this one into a real iOS/Android app you can submit to the app
   stores, without rewriting anything.

4. **Add real ads.** The "watch a hint ad" button is a placeholder.
   For a rewarded-video model like this, Google AdMob's rewarded ad unit
   is the standard choice and plugs into Capacitor via a community
   plugin. Because it's opt-in (the player chooses to watch for a
   reward), it tends to be the least disruptive ad format for casual
   games.

5. **Move the daily puzzle server-side (optional, later).** Right now
   "today's puzzle" is computed locally from the date, cycling through a
   fixed list — good enough for testing, but it means the list eventually
   repeats and can't be updated remotely. A tiny backend (even a static
   JSON file you update weekly) fixes both.

## Verifying puzzle chains

Every curated puzzle in `words.js` should have a verified solution chain
where each step is a real word differing by exactly one letter. If you
add a puzzle, sanity-check it the same way this prototype was checked —
list out the intended chain, confirm each word is in the dictionary, and
confirm each consecutive pair differs by exactly one letter.
