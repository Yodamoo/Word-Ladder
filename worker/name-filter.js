// name-filter.js — blocks offensive leaderboard names. Heuristic, not
// bulletproof: it catches common spellings, leetspeak, separators and
// stretched letters, while avoiding false positives like "therapist",
// "Montenegro", "Cassidy", "Dickens", "swanky" or "Fukuda".

// Matched anywhere in the name once it's squashed to letters only, so only
// strings that essentially never occur inside innocent words or names.
const SUBSTRINGS = [
  "fuck", "shit", "cunt", "bitch", "biatch", "nigg", "faggot", "fagot", "retard",
  "whore", "slut", "twat", "wanker", "porn", "dildo", "pussy", "penis", "vagina",
  "jizz", "rapey", "hitler", "asshole", "bastard", "motherf", "blowjob", "handjob",
  "boner", "tranny", "kkk", "molest", "pedophil", "paedophil", "incest", "cocksuck",
  "dickhead", "dickwad", "cumshot", "cumslut", "clit", "wetback", "beaner",
  "chingchong", "raghead", "towelhead", "spastic", "killyourself",
];

// Real names/places that contain a substring above, removed before checking.
const ALLOWED_FRAGMENTS = ["kshitij", "scunthorpe", "penistone", "shitake", "shiitake"];

// Matched only as whole words (plurals included), because they also appear
// inside innocent words: cocktail, dickens, spice, raccoon, grape, class,
// therapist, canal, torpedo, skyscraper, Tanigawa, ...
const WORDS = [
  "ass", "arse", "cock", "dick", "cum", "tit", "titty", "titties", "fag", "spic",
  "spick", "kike", "coon", "gook", "chink", "paki", "dyke", "rape", "raped",
  "rapist", "sex", "sexy", "nude", "piss", "hoe", "thot", "jap", "lesbo", "semen",
  "anal", "negro", "nazi", "pedo", "kys", "fuk", "niga", "wank", "wanking", "horny",
];

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
  "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };
const LEET_RE = /[01345789@$!|+]/g;

const collapseAll = s => s.replace(/(.)\1+/g, "$1");     // "fuuck" -> "fuck"
const collapseLong = s => s.replace(/(.)\1{2,}/g, "$1"); // "fuuuck" -> "fuck", keeps "ass"

// Collapsing every double letter would turn short entries into innocent
// fragments ("kkk" -> "k"), so that variant is only used for longer entries.
const SUBSTRINGS_COLLAPSED = SUBSTRINGS.map(collapseAll).filter(s => s.length >= 4);

export function isNameAllowed(name) {
  let squashed = name.toLowerCase().replace(LEET_RE, ch => LEET[ch]).replace(/[^a-z]/g, "");
  for (const ok of ALLOWED_FRAGMENTS) squashed = squashed.split(ok).join("");
  const long = collapseLong(squashed);
  if (SUBSTRINGS.some(w => squashed.includes(w) || long.includes(w))) return false;
  const all = collapseAll(squashed);
  if (SUBSTRINGS_COLLAPSED.some(w => all.includes(w))) return false;

  // Whole words: split on non-letters and camelCase ("BigDick" -> big, dick).
  const tokens = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(LEET_RE, ch => LEET[ch])
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(collapseLong);
  for (const t of tokens) {
    for (const w of WORDS) {
      if (t === w || t === w + "s" || t === w + "es") return false;
    }
  }
  return true;
}
