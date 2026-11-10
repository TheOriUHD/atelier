/**
 * The spinner while a reply is on its way: a dab of paint swelling, and words from the studio. A word stays for a few
 * seconds; what the run is waiting on (a local model loading, a retry) replaces it with plain words.
 */
export const DAB_FRAMES = ['·', '∘', '○', '◎', '◉', '◎', '○', '∘'];
export const DAB_STEP_MS = 120;

export const STUDIO_WORDS = [
  'Sketching',
  'Priming the canvas',
  'Mixing pigments',
  'Underpainting',
  'Blocking in',
  'Glazing',
  'Scumbling',
  'Cross-hatching',
  'Stippling',
  'Blending',
  'Shading',
  'Chiselling',
  'Throwing clay',
  'Kiln-firing',
  'Gilding',
  'Etching',
  'Inking',
  'Burnishing',
  'Stretching the canvas',
  'Squinting at it',
  'Stepping back',
  'Varnishing',
  'Framing',
];

/** What each word says once the work is done, for the line under a finished turn ("Glazed for 29s"). */
export const STUDIO_PAST = [
  'Sketched',
  'Primed the canvas',
  'Mixed pigments',
  'Underpainted',
  'Blocked in',
  'Glazed',
  'Scumbled',
  'Cross-hatched',
  'Stippled',
  'Blended',
  'Shaded',
  'Chiselled',
  'Threw clay',
  'Kiln-fired',
  'Gilded',
  'Etched',
  'Inked',
  'Burnished',
  'Stretched the canvas',
  'Squinted at it',
  'Stepped back',
  'Varnished',
  'Framed',
];

const studioIndex = (since: number, now: number) => (Math.floor(since / 1000) + Math.floor(Math.max(0, now - since) / 6000)) % STUDIO_WORDS.length;

/** The word for a run that began at `since`: a new one every 6 seconds, the same for everyone looking at that moment. */
export function studioWord(since: number, now: number): string {
  return STUDIO_WORDS[studioIndex(since, now)]!;
}

/** The word the spinner showed when a run that began at `since` ended at `end`, said as done: "Glazing…" ends as "Glazed". */
export function studioPast(since: number, end: number): string {
  return STUDIO_PAST[studioIndex(since, end)]!;
}

/** Tips at the start, one per start, in turn. */
export const TIPS = [
  'Start it here, finish it in the browser: /open',
  'Shift+Tab switches between Auto, Ask, Accept edits and Plan.',
  'Type while it works: your message waits for its turn. Ctrl+Enter adds it to the turn going on.',
  '@ finds a file in this folder; ! runs a command here and shows the model its output.',
  'Esc stops the reply; Esc twice goes back to an earlier message.',
  'Ctrl+O shows thinking, then every step in full.',
  '/model picks another model for this session; /effort says how hard it thinks.',
  '/resume opens any session, also those started in the browser or the desktop app.',
  'Paste an image (or drop its file) and the model sees it.',
  'Your CLAUDE.md, skills, commands and hooks work here too.',
];
