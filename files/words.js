// words.js
// MVP word list: hand-curated common short words, enough to validate the
// curated puzzle chains below plus reasonable player detours.
// NEXT STEP: swap this for a full English word list (e.g. the free SCOWL /
// ENABLE word lists) once you're working in a real dev environment with
// internet access, and run WORDS through the same length-bucketing below.

const WORD_LIST = [
  // 3-letter
  "cat","cot","cog","dog","cap","cop","con","can","cob","cab","bat","bag",
  "bad","bar","bay","car","cut","cup","cub","cow","coo","cod","bog","boy",
  "bow","boo","bob","dot","dig","din","dip","dab","dam","day","rat","ran",
  "run","rag","rig","rim","rip","rug","rub","rot","rob","hat","hit","hot",
  "hop","hip","ham","has","had","him","his","hen","her","get","got","gap",
  "gas","gum","gun","gut","fat","fit","fun","fox","fig","fin","fix","few",
  "man","map","mat","mad","mud","mum","mob","mop","sun","sin","sit","sat",
  "sad","say","see","sea","set","sew","sob","son","top","tap","tip","toy",
  "toe","tar","tan","ten","tin","two","act","ace","ate","ape","axe","and",
  "any","are","art","ask","air","all","arm","van","vat","win","wit","won",
  "was","way","wet","wed","who","why","yes","yet","you","zoo","own","oil",
  "old","one","out","our","off","one","end","egg","eye","ear","eat","era",
  "pig","pit","pot","pop","pen","pit","pan","paw","pay","pea","pet",
  "lap","lip","log","lot","low","lay","law","let","lid","lie","led",
  "nap","net","new","nod","nor","not","now","nut","jam","jar","jaw","joy",
  "job","kid","key","keg","big",

  // 4-letter (needed for warm/cold, head/tail, love/time chains + extras)
  "warm","worm","word","cord","cold","corn","core","bore","bone","bane",
  "cane","cape","care","case","cast","cost","coat","goat","goad","load",
  "road","read","real","seal","sear","star","stir","stir","scar","scat",
  "seat","sear","hear","heat","heal","teal","tell","tall","tail","head",
  "held","help","heap","hemp","harp","hard","herd","here","hire","fire",
  "fine","find","fund","fond","bond","band","bend","lend","land","hand",
  "sand","send","sent","dent","dint","mint","mind","mend","mold","bold",
  "bald","ball","bell","belt","bolt","boot","boat","coot","cool","pool",
  "poll","pole","hole","hold","gold","golf","gulf","gull","full","fall",
  "fill","film","firm","form","fort","sort","sore","more","mare","male",
  "mile","mild","wild","wile","wine","wane","cane","came","come","dome",
  "dose","rose","nose","note","nope","rope","ripe","rite","site","side",
  "size","sire","hire","hare","haze","maze","mace","race","rack","rock",
  "lock","lick","lice","rice","nice","nine","mine","dine","dime","time",
  "tide","tile","mile","lime","live","hive","have","gave","give","five",
  "five","love","lose","lost","cost","cast","case","cave","cove","cope",
  "code","mode","made","wade","wane","want","wart","cart","card","cars",
];

// exact copy, kept distinct from WORD_LIST for tests / potential swap-out
const WORDS = new Set(WORD_LIST.map(w => w.toUpperCase()));

// Curated puzzles, hand-verified: every intermediate word is real and each
// step changes exactly one letter. par = shortest known solution length.
const PUZZLES = [
  { start: "CAP", end: "HAT", par: 2 },
  { start: "BIG", end: "BAD", par: 2 },
  { start: "BAT", end: "RUN", par: 3 },
  { start: "CAT", end: "DOG", par: 3 },
  { start: "LOVE", end: "TIME", par: 3 },
  { start: "WARM", end: "COLD", par: 4 },
  { start: "HEAD", end: "TAIL", par: 5 },
];
