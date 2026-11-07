import { AppWindow, Blocks, Bot, Cloud, FileDiff, Film, FolderInput, GitBranch, History, Monitor, Link, Clock, Cpu, FileText, Gauge, Images, Keyboard, KeyRound, ListX, MessageSquareText, MessagesSquare, MousePointerClick, Plug, RefreshCw, Repeat2, Server, ShieldCheck, SlidersHorizontal, SquareTerminal, Timer, Users, Volume2, type LucideIcon } from 'lucide-react';

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
    version: '0.5.2',
    intro: 'Mistral’s models, GLM above all, work through long coding tasks instead of stopping or saving half-written files.',
    highlights: [
      {
        icon: Cloud,
        title: 'GLM no longer saves half a file',
        body: 'When GLM ran out of room in the middle of writing a file, Mistral ended the reply as if the file were complete, and Atelier saved half of it; the model then wrote it again and ran out again. Such a reply is now taken as cut off: nothing in it runs, and the model is asked to send it again, split up.',
      },
      {
        icon: Gauge,
        title: 'Room to think',
        body: 'Mistral counts a model’s reasoning toward its output limit, and GLM can reason tens of thousands of tokens on a bigger task before it writes anything. A turn on a Mistral model that reasons now gets the model’s own limit, as Mistral’s Vibe does, so such replies are no longer cut off with nothing in them.',
      },
    ],
    also: ['Mistral Medium 3.5 shows under its name again (Mistral lists it as mistral-medium-latest now), and GLM 5.2 and DeepSeek’s effort levels are known.', 'Each Mistral model gets only the reasoning efforts its API takes, checked against it.', 'A Mistral reply that fails or shows nothing leaves an outline in the log for Copy diagnostics, without the words of the conversation.'],
  },
  {
    version: '0.5.1',
    intro: 'Co-op guests file the session in their own sidebar and follow its sub-agents and tracks.',
    highlights: [
      {
        icon: Users,
        title: 'Your own sidebar in someone else’s session',
        body: 'Pin a session you joined, rename it, put it in one of your groups, archive it or mark it unread, on a team server and between computers. Only you see it: the session keeps its name and place for the host and the others.',
      },
      {
        icon: GitBranch,
        title: 'Sub-agents and tracks for everyone',
        body: 'Guests on another computer open the transcript of a sub-agent or a track, and in Code the Background tasks pane with what runs and a command’s output. Stopping and clearing background tasks is the host’s.',
      },
    ],
    also: ['File › Join a Co-op Session… in the desktop app opens the dialog to paste an invite link.', 'When this computer’s protected storage refuses co-op’s keys, co-op says so instead of “Internal error”.'],
  },
  {
    version: '0.5.0',
    intro: 'Co-op: work in one session with up to three other people, each writing and watching the agent work. There is no account.',
    highlights: [
      {
        icon: Users,
        title: 'Work in one session together',
        body: 'Click Co-op in a session’s header and send the invite link. The people you let in work in the same conversation and the same folder: each writes their own messages and sees every reply as it is written. You let each person in after comparing four emoji with them. Between two computers the apps meet through an encrypted relay that can’t read what passes; on a team server you add teammates instead.',
      },
      {
        icon: Bot,
        title: 'Your models or theirs',
        body: 'Each person picks whose models answer them: the host’s, within a daily limit the host sets, or their own providers and plans, which run on their own computer with their own keys.',
      },
      {
        icon: ShieldCheck,
        title: 'The host’s computer stays the host’s',
        body: 'In a guest’s turn, commands, anything outside the folder and edits to files that make tools run things ask the host, whatever the permission mode. Questions nobody answers within 5 minutes are declined. A shared session carries no memory, personalization or project context.',
      },
      {
        icon: GitBranch,
        title: 'More together',
        body: 'Ask another model for a second opinion beside the first answer, name a model with @ for one message, and react to messages. A navigator can look over every edit in the others’ turns, and in Code an agent can work on a parallel track in its own git worktree, which the host merges.',
      },
    ],
    also: ['Guests keep a copy of the conversation when co-op ends, unless the host switches that off.', 'The host’s computer stays awake while co-op is on.', 'A server you run yourself can run its own co-op relay.'],
  },
  {
    version: '0.4.4',
    intro: 'A fix for GLM and DeepSeek through Mistral.',
    highlights: [
      {
        icon: MessagesSquare,
        title: 'GLM and DeepSeek on Mistral show their replies',
        body: 'These models, which Mistral hosts for their makers, could answer with nothing on screen while they worked up to their output limit, because Atelier only read Mistral’s own reply format. It now reads theirs too. And a reply that uses its whole output limit without writing anything is tried once more, then stops with a message instead of starting over.',
      },
    ],
    also: [],
  },
  {
    version: '0.4.3',
    intro: 'A fix for conversations that compact often.',
    highlights: [
      {
        icon: MessagesSquare,
        title: 'Earlier messages stay through quick compactions',
        body: 'When a session compacted twice in quick succession, as it can with a small context window and large tool results, the conversation could lose everything before its newest reply, the Compacted session lines included, until it was opened again. It now keeps them.',
      },
    ],
    also: [],
  },
  {
    version: '0.4.2',
    intro: 'Assistants can speak, make music and sound effects. Mistral joins the providers, Vibe plan included. Edits show where they are in the file, and a session can move to another folder.',
    highlights: [
      {
        icon: Volume2,
        title: 'Speech, music and sound effects',
        body: 'Add an audio provider in Settings › Media, such as ElevenLabs, OpenAI, Google Gemini or a server on your own computer like Kokoro or ComfyUI, and ask for something to hear: a text read aloud in a voice, a song, a sound effect. It plays right in the conversation, with its waveform to seek on.',
      },
      {
        icon: Cloud,
        title: 'Mistral, and your Vibe plan',
        body: 'Add Mistral in Settings › Admin › Providers with a key from Mistral’s console, or choose Mistral Vibe and paste the Vibe key from your Le Chat Pro or Team plan to use its allowance instead of paying per token. Large 4, Medium 3.5, Small 4, Codestral and the rest are listed with their reasoning levels, and the context ring shows how much of the month’s Vibe allowance is used.',
      },
      {
        icon: FileDiff,
        title: 'Line numbers and the whole file for every edit',
        body: 'An edit in the conversation now shows the file’s line numbers and a few lines above and below the change. Show the whole file, in the corner of the diff, opens the whole file as it is now with that change in place, scrolled to it. Edits from before this version keep their old diff.',
      },
      {
        icon: FolderInput,
        title: 'Move a session to another folder',
        body: 'Click the folder in a Code or Cowork session’s header and pick another of your folders on the same computer, or open one. The conversation goes on there, the model is told, and Undo moves it back. A reply that is running finishes first.',
      },
    ],
    also: ['Permission cards show the lines around an edit too.', 'Rewind after a folder change restores each file in its own folder. It used to write the old folder’s files into the new one.', 'The clock under a running reply starts again from zero on Retry, instead of counting from when the message was first sent.', 'Leaving Ultracode no longer leaves faint cells on the effort slider the next time it opens.'],
  },
  {
    version: '0.4.1',
    intro: 'Atelier keeps its icon on Windows.',
    highlights: [
      {
        icon: AppWindow,
        title: 'The taskbar icon survives updates',
        body: 'After an update Windows could show a blank page instead of Atelier’s icon in the taskbar and on its shortcuts, because the update replaces Atelier.exe and Windows kept what it saw while the file was gone. Atelier’s windows now carry the icon themselves, and its shortcuts and taskbar pins take theirs from a copy that updates never touch. Shortcuts that are already blank are mended the first time this version starts.',
      },
    ],
    also: [],
  },
  {
    version: '0.4.0',
    intro: 'Video generation, drawing over part of an image to change it, limits and an activity log for shared servers, and computer use on Linux.',
    highlights: [
      {
        icon: Film,
        title: 'Video generation',
        body: 'Image providers can make video now: ComfyUI workflows, SwarmUI, fal, Replicate, OpenRouter, xAI, Black Forest Labs and Gemini. Ask for a clip in Chat, Code or Cowork and it plays in the conversation, can be saved to your folder, and is kept in Images with a filter for videos. None of these has run against a real service yet.',
      },
      {
        icon: Images,
        title: 'Change part of an image',
        body: 'Brush over an area of a generated image, say what should change there, and only that area is redone. Generated images can also be used inside artifacts and visuals.',
      },
      {
        icon: Gauge,
        title: 'Limits for shared servers',
        body: 'Admins can limit tokens, cost and requests per person, with exceptions for single people. People see their own usage against their limits, and a warning at 80%.',
      },
      {
        icon: History,
        title: 'An activity log',
        body: 'Settings › Admin › Activity records who signed in, who changed accounts, providers, settings and limits, and when. It never records secrets, and it can be exported.',
      },
      {
        icon: Monitor,
        title: 'Computer use on Linux',
        body: 'The assistant can use apps on a Linux desktop running X11: Full control and asking per app, with the same safeguards as on the Mac and Windows. Wayland sessions are limited to apps that run through XWayland.',
      },
      {
        icon: ShieldCheck,
        title: 'Stricter and kinder permissions',
        body: 'Working outside the workspace folder now works on a server too, and one approval covers a folder in Ask mode. Hidden models can’t be used by name, a file is only readable by the account it belongs to, and web fetches can’t be redirected to your own network. Copy diagnostics in Settings › System makes bug reports easy without sending anything on its own.',
      },
    ],
    also: [
      'The model you pick in a conversation is the one the next one starts with (Settings › General turns this off).',
      'Windows downloads are smaller: one installer for each type of processor.',
      'Log out and Change setup no longer wait on slow file watchers.',
      'Your data export includes images that only exist inside messages.',
      'The settings close button no longer sits over Log out.',
    ],
  },
  {
    version: '0.3.1',
    intro: 'Fixes from the first day of 0.3.0.',
    highlights: [
      {
        icon: AppWindow,
        title: 'Updating a server no longer breaks the app',
        body: 'A desktop app connected to a server that was updating to 0.3.0 could show only “Something went wrong!” until it was quit from Task Manager. It now carries on through the update, and if a window ever breaks, it says what happened and offers Reload.',
      },
      {
        icon: Link,
        title: 'Windows shortcuts mend themselves',
        body: 'A desktop, Start menu or taskbar shortcut to Atelier that lost its icon, or points at an Atelier that moved, is fixed when Atelier starts. After every update Atelier rewrites them, so Windows shows the icon again.',
      },
    ],
    also: [],
  },
  {
    version: '0.3.0',
    intro: 'Atelier makes images now, on your own GPU or through any major service, right in the conversation. Permission cards tell you more, too.',
    highlights: [
      {
        icon: Images,
        title: 'Image generation',
        body: 'Add an image provider in Settings › Admin › Image providers: ComfyUI, Forge, SwarmUI, InvokeAI and other servers of your own, or OpenAI, Google, Black Forest Labs, Stability, xAI, OpenRouter, fal, Replicate and more. Then any text model that can call tools can make images in Chat, Code and Cowork. A frame in the final shape shows live progress, and on most local servers you watch the picture form. Ask for a change and it edits that image; in Code and Cowork it can save one to your folder, and Rewind undoes it. Images in the sidebar keeps everything you’ve made. Nothing changes until you add a provider.',
      },
      {
        icon: Cpu,
        title: 'Text and images on one GPU',
        body: 'If an image server shares a GPU with a local text model, set Shares a GPU with on its provider: they take turns in one queue, and the text model steps aside while the image renders. On a server, your own ComfyUI or Forge works from your sessions through the desktop app, under Settings › Your models.',
      },
      {
        icon: ShieldCheck,
        title: 'Permission cards say more',
        body: 'Deny with reason tells the assistant why, so it can take another route. The diff shows real line numbers, and Show the whole file opens the change in place with the code around it, so you can decide without another editor. Settings › Code › Permissions › Explain each change adds a short reason to every edit; it’s off by default because it costs tokens.',
      },
      {
        icon: AppWindow,
        title: 'Atelier opens as Atelier',
        body: 'The hidden browser window behind ChatGPT Chat could keep Atelier running after you closed it, and opening Atelier then showed that window instead, with only Task Manager as a way out. Closing Atelier’s last window now quits it, and opening it always shows Atelier.',
      },
    ],
    also: ['Every image that opens big now zooms and pans.', 'A model that can’t see images no longer gets them from tools, which could make a provider refuse the whole request.'],
  },
  {
    version: '0.2.15',
    intro: 'Connect your identity provider from the desktop app, without going to a browser.',
    highlights: [
      {
        icon: KeyRound,
        title: 'Connected sign-ins in the desktop app',
        body: 'In Settings › Account › Connected sign-ins, Connect opens your provider’s sign-in in a small window that closes by itself when you’re done, and you can disconnect it there too. If the app reaches your server at a different address than your browser does, your provider needs that address’s redirect URI as well. Providers that refuse app windows, such as Google, can still be connected with Open in browser.',
      },
    ],
    also: ['Links to a setting reach it even when its section loads a moment later.'],
  },
  {
    version: '0.2.14',
    intro: 'Sign in to a server through your own identity provider, and two fixes for computer use on Windows.',
    highlights: [
      {
        icon: KeyRound,
        title: 'Single sign-on',
        body: 'In a browser, people can sign in to an Atelier server through Authentik, Keycloak, Google or anything else that speaks OpenID Connect. An admin adds the provider in Settings › Admin › Server › Single sign-on and chooses what happens to someone new: they wait for approval, get an account right away or are turned away. An existing account connects it once in Settings › Account › Connected sign-ins. The desktop app keeps signing in with passwords.',
      },
      {
        icon: MousePointerClick,
        title: 'Computer use on Windows',
        body: 'Atelier stays on the taskbar when the assistant takes over and comes back as it was; before, it could look like it had quit. Text typed in Full control comes out right in apps like Notepad, which could show repeated letters. It now types about 30 characters a second.',
      },
    ],
    also: ['Settings › System shows the copyright under the version.'],
  },
  {
    version: '0.2.13',
    intro: 'Background computer use works in the background now, and the assistant isn’t thrown off when you use your computer.',
    highlights: [
      {
        icon: MousePointerClick,
        title: 'Background works in the background',
        body: 'With Background chosen in Settings › System › Computer use, the assistant works in one app’s window at a time without your mouse and keyboard: it sees the window even when others cover it and clicks and types in it while you keep working. A small note says which app it works in. Dragging and zooming still need Full control, which it asks for.',
      },
      {
        icon: ShieldCheck,
        title: 'You and the assistant on one computer',
        body: 'Moving the mouse while it works changes nothing; when you click or type it waits until you stop and carries on. Holding Esc gives you the computer back without ending the reply: the assistant finishes another way, or says what it couldn’t do and why.',
      },
    ],
    also: [
      'Browsers start with full use on the access card, like other apps, and the assistant asks again when it needs more in an app.',
      'The assistant replaces a field’s text instead of adding to it, and fixes slips without reloading the page.',
    ],
  },
  {
    version: '0.2.12',
    intro: 'Computer use comes to Windows, and Atelier no longer stays invisible when its start goes wrong.',
    highlights: [
      {
        icon: MousePointerClick,
        title: 'Computer use on Windows',
        body: 'Turn it on in Settings › System › Computer use: the assistant in Code and Cowork can see and use your apps, as on the Mac. Windows asks for no permissions; shortcuts use Ctrl, and apps running as administrator can’t be used. Your password managers start on the denied list, and holding Esc for a second stops it.',
      },
      {
        icon: ShieldCheck,
        title: 'A start that goes wrong says so',
        body: 'On Windows, Atelier could keep running in the background without ever showing its window. Now a start that fails explains why and where the details are, a window that doesn’t appear is shown after a few seconds, and opening Atelier again brings its window back.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.11',
    intro: 'The assistant can use your Mac, and the message box suggests your next reply.',
    highlights: [
      {
        icon: MousePointerClick,
        title: 'Computer use (macOS)',
        body: 'Turn it on in Settings › System › Computer use, give Atelier Accessibility and Screen recording, and the assistant in Code and Cowork can see and use your apps. Full control takes over your computer as it is; Background asks for each app first. The screen’s edges glow while it works, holding Esc for a second stops it, and when it’s done Atelier comes back to the front. Clicks and typing follow your permission mode like any action, and your denied apps (password managers to start with) stay off-limits.',
      },
      {
        icon: MessageSquareText,
        title: 'Suggested replies',
        body: 'When a reply ends in Code or Cowork, the empty message box shows a short guess at your next message in grey, like “push it” when that’s what you usually say. Tab puts it in as your own text. It comes back whenever the box is empty, until you send.',
      },
    ],
    also: [
      'The assistant does the work you ask for, also when you ask it as a question (“can you start?”).',
      'A session the assistant moved to another folder shows that folder in the sidebar, the Terminal and the Run button.',
      'Several windows, devices and the browser stay in step: branches, deleted chats, SSH questions, side chats, projects and lent folders.',
      'Run in terminal works for PowerShell code blocks.',
    ],
  },
  {
    version: '0.2.10',
    intro: 'The commands the assistant runs are color-coded.',
    highlights: [
      {
        icon: SquareTerminal,
        title: 'Color-coded commands',
        body: 'Commands in Code and Cowork steps, in Background tasks and in the “Allow Atelier to run …?” prompt are highlighted like code blocks, in your syntax themes: bash, PowerShell when a command reads like it, and a here-document in its own language, so a Python script passed to python3 reads as Python.',
      },
    ],
    also: [],
  },
  {
    version: '0.2.9',
    intro: 'Give the assistant an MCP server and it can use it, and connectors that can’t be reached say why.',
    highlights: [
      {
        icon: Blocks,
        title: 'Hand the assistant an MCP server',
        body: 'Paste an MCP server’s address, like Fusion 360’s http://127.0.0.1:27182/mcp, into any conversation: the assistant asks to add it, and once you click Add connector its tools work right away in that conversation. On a server it becomes one of your own connectors, reached through the desktop app where you clicked Add.',
      },
      {
        icon: Plug,
        title: 'Clear connector errors',
        body: 'A connector that can’t be reached now says where and why, like “Can’t reach 127.0.0.1:27182: nothing answers there”, instead of “fetch failed”. On a server, an admin connector at localhost explains that this address is the server itself and points to Your connectors.',
      },
    ],
    also: [],
  },
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
