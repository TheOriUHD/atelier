import { Blocks, Clock, Cpu, FileText, Gauge, Keyboard, ListX, MessagesSquare, RefreshCw, Repeat2, Server, ShieldCheck, SlidersHorizontal, Timer, Volume2, type LucideIcon } from 'lucide-react';

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
    version: '0.2.8',
    intro: 'Connected to a server, the desktop app keeps what it does on your computer: the server keeps your chats and settings in sync, and your computer lends the rest.',
    highlights: [
      {
        icon: Server,
        title: 'SSH hosts and No folder on a server',
        body: 'Code sessions on an SSH host go out from your computer, with its ssh, keys and known hosts, and a session without a folder gets one made on your computer. Each needs your say-so once on that computer; Settings › System lists what it lends, with Remove.',
      },
      {
        icon: Blocks,
        title: 'Your own connectors',
        body: 'Customize › Connectors › Your connectors: anyone can add connectors only they use, with keys only they give. One that runs a program runs it on your computer, and only the exact command you allowed there. Import from Claude Code works there too.',
      },
      {
        icon: FileText,
        title: 'Your computer’s config in Code',
        body: 'A Code session in a folder on your computer gets your ~/.claude and ~/.atelier instructions, skills, commands, agents and Claude Code plugins from that computer, as when it runs on its own. Customize lists them “From” that computer.',
      },
      {
        icon: Cpu,
        title: 'Models on your computers',
        body: 'Settings › Your models adds the Ollama, llama.cpp or LM Studio on your computer, or its ChatGPT Chat. Only you see them, under your computer’s name in the model menu, while that computer is connected.',
      },
    ],
    also: ['Settings › Admin › Models: the list of models in use is now called Enabled, next to Browse catalog.'],
  },
  {
    version: '0.2.7',
    intro: 'Calmer focus rings, and a tidier Settings list.',
    highlights: [
      {
        icon: Keyboard,
        title: 'Focus rings only when you use Tab',
        body: 'The blue frame around a button or field now shows only after you press Tab, and goes away at your next click. A click, a shortcut or the keys of a screenshot no longer light anything up.',
      },
      {
        icon: SlidersHorizontal,
        title: 'Settings › Shortcuts',
        body: 'The keyboard shortcuts page is called Shortcuts in the Settings list, which keeps every page name on one line.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.6',
    intro: 'Your ChatGPT plan’s limits everywhere, answers from another model, replies read aloud and shortcuts of your own.',
    highlights: [
      {
        icon: Gauge,
        title: 'Plan limits in Chat and Cowork',
        body: 'Click the context ring under the message box: it shows how full the conversation is and, with ChatGPT Plan, how much of your 5-hour and weekly limits you have used. From 90% a line above the message box says so. Click “Resets in …” to see the time it resets instead, on your computer’s 12- or 24-hour clock.',
      },
      {
        icon: Repeat2,
        title: 'Retry with another model',
        body: 'Click the model name under a reply and pick another model: it answers the same message again as a new version of the reply, and the conversation goes on with it. The arrows switch between the versions.',
      },
      {
        icon: Volume2,
        title: 'Read aloud',
        body: 'The speaker button under a reply reads it with one of your computer’s own voices, so nothing is sent anywhere. Code blocks and link addresses are skipped, and a German reply gets a German voice.',
      },
      {
        icon: Keyboard,
        title: 'Your own keyboard shortcuts',
        body: 'Settings › Shortcuts changes the keys for a new chat, search, settings, the sidebar, uploads and more, or turns one off. Keys already in use are refused with the reason, and the menu bar shows yours.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.5',
    intro: 'ChatGPT Chat lists its models on every system language, and a security update.',
    highlights: [
      {
        icon: MessagesSquare,
        title: 'ChatGPT Chat’s models in any language',
        body: 'On a computer set to German (or any language but English), ChatGPT Chat showed only “ChatGPT Chat” instead of ChatGPT’s own models and their effort steps. Its window now always opens ChatGPT in English, which Atelier reads.',
      },
      {
        icon: ShieldCheck,
        title: 'Safer connectors and math',
        body: 'The library Atelier talks to connectors (MCP servers) with is updated to fix how it handles HTTP requests and sign-ins, and the math renderer to fix a way around its safety checks.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.4',
    intro: 'A smoother first start, on the desktop and on a server.',
    highlights: [
      {
        icon: MessagesSquare,
        title: 'Straight to the chat',
        body: 'With no model set up yet, Atelier opens on the normal chat. The model menu under the message box offers Add a provider, which shows what Atelier found on this computer.',
      },
      {
        icon: Server,
        title: 'The server setup installs Docker for you',
        body: 'Run curl -fsSL https://updates.atelierhq.dev/install | sudo sh: on Linux it installs or starts Docker itself when it is missing, and the download shows a bar per image instead of scrolling lines.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.3',
    intro: 'A small release that keeps updates coming on every Mac.',
    highlights: [
      {
        icon: RefreshCw,
        title: 'Mac updates no longer get stuck',
        body: 'An update that was downloaded but never installed could stop every later one with “Couldn’t download Atelier …: ENOTEMPTY”. The update folder is now cleared properly, so new versions arrive again.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.2',
    intro: 'A server is now one command to set up, the update settings say what is going on, and the version number moves on to 0.2.',
    highlights: [
      {
        icon: Server,
        title: 'Set up a server with one command',
        body: 'On a Linux or macOS machine, curl -fsSL https://updates.atelierhq.dev/install | sudo sh starts a setup wizard: it checks the machine, asks how people will reach the server, starts it, tests the address like a browser would and creates your account.',
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
