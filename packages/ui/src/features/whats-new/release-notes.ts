import { Clock, Cpu, ListX, MessagesSquare, RefreshCw, Server, ShieldCheck, SlidersHorizontal, Timer, type LucideIcon } from 'lucide-react';

/** One thing worth a paragraph: what changed for the person using Atelier, in their words. */
export interface Highlight {
  icon: LucideIcon;
  title: string;
  body: string;
}

/** What a release tells people when they first open it. Written by hand, newest first; the CHANGELOG has everything. */
export interface ReleaseNotes {
  version: string;
  /** One or two sentences under the title. */
  intro: string;
  highlights: Highlight[];
  /** Smaller changes, one line each. */
  also: string[];
}

export const RELEASE_NOTES: readonly ReleaseNotes[] = [
  {
    version: '0.2.2',
    intro: 'A server is now one command to set up, the update settings say what is going on, and the version number moves on to 0.2.',
    highlights: [
      {
        icon: Server,
        title: 'Set up a server with one command',
        body: 'On a Linux or macOS machine with Docker, curl -fsSL https://updates.atelierhq.dev/install | sh starts a setup wizard: it checks the machine, asks how people will reach the server, starts it, tests the address like a browser would and creates your account.',
      },
      {
        icon: RefreshCw,
        title: 'Clearer update settings',
        body: 'A copy of Atelier that has nowhere to look for updates now says so and points to the Releases page, instead of talking about servers.',
      },
    ],
    also: [
      'Since 0.1.10: agents can read the time and their plan limits, one call stops all background work, and messages show how long ago they were sent.',
    ],
  },
  {
    version: '0.1.11',
    intro: 'Agents can tell the time and see their limits, stopping background work takes one call, and messages show how long ago they were sent.',
    highlights: [
      {
        icon: Clock,
        title: 'Agents know the time and their limits',
        body: 'An agent can read the date and time without searching the web. On a ChatGPT plan or a paid API it can also see how much of the weekly and 5-hour limit, or of the cost, is used, so it can tell you before a long job runs into one.',
      },
      {
        icon: ListX,
        title: 'Stop all background work at once',
        body: 'Ask an agent to stop the background tasks and it stops every command, sub-agent and loop in one call instead of one by one.',
      },
      {
        icon: Timer,
        title: 'Times that mean something',
        body: 'A finished message shows how long ago it was sent; click it for the exact date and time. The running line counts the whole turn, from your message to the reply, instead of starting over with every step.',
      },
    ],
    also: [
      'The Reply button over selected text keeps its solid background when you point at it.',
      'Settings changed in quick succession can no longer bring an older value back.',
    ],
  },
  {
    version: '0.1.10',
    intro: 'ChatGPT gets a second way in, thinking becomes a switch you control, and a handful of permission gaps are closed.',
    highlights: [
      {
        icon: MessagesSquare,
        title: 'ChatGPT Chat, experimental',
        body: 'A second way to use your ChatGPT plan: Atelier drives a signed-in browser window, so you get ChatGPT’s own models and thinking levels, images and PDFs, and tools that run on your computer. It’s unofficial and can break whenever ChatGPT changes, so adding it starts with a warning.',
      },
      {
        icon: SlidersHorizontal,
        title: 'Thinking and effort that fit the model',
        body: 'Models that can only think on or off now have a Thinking switch in the effort menu. For ChatGPT Chat, the steps ChatGPT itself offers, Instant to Pro, become the notches of the slider.',
      },
      {
        icon: Cpu,
        title: 'Local models sized to your GPU',
        body: 'Enter the video memory you can spare, in GB, and Atelier works out each Ollama model’s context window from the model itself. Settings › Models lists what you have and a catalog of what you could add.',
      },
      {
        icon: ShieldCheck,
        title: 'Tighter permissions',
        body: 'A codespace asks “Trust this workspace?” before its hooks run, “Always allow” for a file outside your project covers only that folder, and a hook’s “allow” no longer skips your ask rules. On a server, accounts can’t reach each other’s chat sandbox.',
      },
      {
        icon: RefreshCw,
        title: 'You decide when Atelier checks for updates',
        body: 'Settings › System has a switch for the automatic check. Off, Atelier asks no update server anything until you press Check now.',
      },
    ],
    also: [
      'Cowork and Code now start on “Default model for everyone”, as Chat always did.',
      'A model that has gone quiet says so, and a plan’s usage limit ends the turn at once instead of retrying ten times.',
      'On a server, remote control lets you continue a conversation on another device, or keep one private to its device.',
      'ChatGPT Pro shows as Pro 100, Pro 200 or Pro 500, with only its weekly limit.',
      'The personality presets are now called Technical and Relaxed.',
    ],
  },
];

/** The notes for exactly this version, or none (a development build has nothing to announce). */
export function releaseNotesFor(version: string): ReleaseNotes | undefined {
  return RELEASE_NOTES.find((notes) => notes.version === version);
}
