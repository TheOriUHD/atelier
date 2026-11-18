// The demo account's conversations (scripts/seed.mjs makes them with the real server and the demo model, which answers each
// `user` text with its `reply`). They are there to show how Atelier writes: headings, lists, tables, code, quotes.
// `project` files a conversation under one of PROJECTS; `pinned` pins it.

export const PROJECTS = [{ name: 'Product launch', description: 'Plans, copy and checklists for the spring launch.' }];

export const CONVERSATIONS = [
  {
    title: 'A weekend in Lisbon',
    pinned: true,
    turns: [
      {
        user: 'Plan a relaxed weekend in Lisbon for two: good food, one museum, lots of walking.',
        reply: `# A relaxed weekend in Lisbon

Here is a plan that keeps the pace slow and the walks short between stops.

## Saturday

- **Morning:** coffee and a *pastel de nata* in Alfama, then wander up to the Miradouro de Santa Luzia for the view.
- **Lunch:** a long, quiet lunch at a tasca in Graça; order the daily fish.
- **Afternoon:** the **Museu Calouste Gulbenkian**: compact, calm, and the garden is lovely.
- **Evening:** dinner in Bairro Alto, then a slow walk down to the river.

## Sunday

- **Morning:** tram 28 early, before the queues, to the Estrela basilica and garden.
- **Lunch:** Time Out Market, only if you are hungry for options; otherwise a bakery picnic.
- **Afternoon:** Belém: the tower from the outside, the monastery if you have the energy.

## What it costs

| Item | Per person | Notes |
| --- | ---: | --- |
| Museum ticket | €10 | Free on Sundays until 2 pm |
| Meals (3 days) | €75 | Tascas are the best value |
| Trams and metro | €12 | A 24-hour card pays off on Saturday |
| **Total** | **≈ €97** | Without the hotel |

> Tip: the hills are steep. Flat shoes beat anything else you could pack.`,
      },
    ],
  },
  {
    title: 'How HTTP caching works',
    turns: [
      {
        user: 'Explain how HTTP caching works, with the headers that matter.',
        reply: `# HTTP caching in five minutes

A cache keeps a copy of a response and decides, for each later request, whether it may reuse that copy.

## The headers that matter

\`\`\`http
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600, stale-while-revalidate=60
ETag: "33a64df5"
Last-Modified: Tue, 17 Nov 2026 09:30:00 GMT
\`\`\`

- **\`max-age\`** is how many seconds the copy counts as fresh.
- **\`stale-while-revalidate\`** lets the cache answer from the old copy while it fetches a new one in the background.
- **\`ETag\`** is a fingerprint of the content, used to ask "has this changed?"

## Revalidating

When the copy is stale, the cache asks the server instead of downloading again:

\`\`\`http
GET /app.js HTTP/1.1
If-None-Match: "33a64df5"
\`\`\`

If nothing changed, the answer is a tiny \`304 Not Modified\` with no body.

## A simple rule of thumb

1. Files with a hash in their name (\`app.4f9c2.js\`): cache for a year, \`immutable\`.
2. HTML pages: \`no-cache\` (always revalidate), so a deploy shows at once.
3. API responses about one person: \`private\`, or \`no-store\` for anything sensitive.

> The hardest bug in caching is the one where a page is fresh in your browser and stale for everyone else.`,
      },
    ],
  },
  {
    title: 'Rename photos by date',
    turns: [
      {
        user: 'Write a Python script that renames the photos in a folder to their date taken, like 2026-11-17_001.jpg.',
        reply: `Here is a script that reads the date each photo was taken and renames the files in order.

\`\`\`python
#!/usr/bin/env python3
"""Rename photos to YYYY-MM-DD_NNN.jpg using their EXIF date (or the file's modified time)."""
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from PIL import Image

def taken(path: Path) -> datetime:
    try:
        raw = Image.open(path).getexif().get(36867)  # DateTimeOriginal
        if raw:
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    return datetime.fromtimestamp(path.stat().st_mtime)

def main(folder: str) -> None:
    counts: dict[str, int] = defaultdict(int)
    for photo in sorted(Path(folder).glob("*.jpg"), key=taken):
        day = taken(photo).strftime("%Y-%m-%d")
        counts[day] += 1
        target = photo.with_name(f"{day}_{counts[day]:03d}.jpg")
        if target != photo:
            photo.rename(target)
            print(f"{photo.name} -> {target.name}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
\`\`\`

Run it with \`python3 rename.py ~/Pictures/trip\`. Two things to know:

- It needs Pillow: \`pip install pillow\`.
- Try it on a **copy** of the folder first; renames are easy to do and tedious to undo.`,
      },
    ],
  },
  {
    title: 'Launch announcement email',
    project: 'Product launch',
    turns: [
      {
        user: 'Draft a short announcement email for our spring launch. Friendly, no hype.',
        reply: `Here is a draft you can adjust.

---

**Subject:** What's new this spring

Hi there,

Thank you for being one of the first people to use our app. Today we are shipping the update you asked for most:

- **Faster search:** results appear as you type, even in large libraries.
- **Shared folders:** invite someone and work on the same files.
- **A calmer look:** fewer buttons, more room for your work.

You do not need to do anything. The update arrives on its own, and your settings stay as they are.

If something does not feel right, reply to this email. A person reads every message.

Warm regards,
The team

---

A few notes on the choices:

1. The subject says what the email is, not how exciting it is.
2. Three bullets are enough; a longer list reads as a press release.
3. It ends with a way to reach a real person.`,
      },
    ],
  },
  {
    title: 'Launch checklist',
    project: 'Product launch',
    turns: [
      {
        user: 'Make me a launch-week checklist, grouped by day.',
        reply: `# Launch week checklist

## Monday: prepare

- [x] Freeze the feature list
- [x] Final pass on the release notes
- [ ] Record the 30-second demo

## Tuesday: test

- [ ] Fresh install on iPhone and iPad
- [ ] Sign in, send a message, sign out
- [ ] Check the privacy policy link works

## Wednesday: submit

- [ ] Upload the build
- [ ] Add the review notes and demo account
- [ ] Schedule the announcement email

## Thursday: launch

- [ ] Publish the release
- [ ] Post the announcement
- [ ] Watch the support inbox

## Friday: look back

| Question | Where to look |
| --- | --- |
| Did anything crash? | Crash reports |
| What did people ask for? | Support inbox |
| What should we fix first? | Your own notes |`,
      },
    ],
  },
  {
    title: 'Two ways to manage app state',
    turns: [
      {
        user: 'Compare keeping state in one store versus keeping it next to each component.',
        reply: `# One store or local state?

Both work. The right choice depends on **who needs the data**.

| | One shared store | State next to the component |
| --- | --- | --- |
| Best for | Data many screens read | Data one screen owns |
| Easy to | Debug, log, undo | Read and delete |
| Hard to | Keep small | Share later |
| Typical size | Grows with the app | Stays tiny |

## A small example

Local state, for something only this form needs:

\`\`\`tsx
function NameField() {
  const [name, setName] = useState("");
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}
\`\`\`

A shared store, for the signed-in person that every screen reads:

\`\`\`tsx
const useSession = create<{ user: string | null; signOut(): void }>((set) => ({
  user: null,
  signOut: () => set({ user: null }),
}));
\`\`\`

## My rule

Start local. Move something into the shared store **the first time a second screen needs it**, and not before. Moving state up is a ten-minute change; untangling a store that holds everything is a week.`,
      },
    ],
  },
];

/** The scripted answers and titles the demo model gets (DEMO_MODEL_SCRIPT). */
export const SCRIPT = CONVERSATIONS.flatMap((c) => c.turns.map((t) => ({ match: t.user, reply: t.reply, title: c.title })));
