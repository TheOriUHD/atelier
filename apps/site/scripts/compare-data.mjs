/**
 * What the comparison pages (/compare/) say. Every fact about another project comes from its own README, docs, licence or
 * terms, read on `CHECKED`; where a page didn't say something it is left out, not guessed. Change a fact here, run
 * `node apps/site/scripts/compare.mjs`, and commit the pages it writes (a test checks they are up to date).
 */

export const CHECKED = '2026-11-16';
export const CHECKED_TEXT = '16 November 2026';
export const SITE = 'https://atelierhq.dev';

/** Atelier's own side of every row (from its README and docs). */
export const ATELIER = {
  licence: 'PolyForm Noncommercial 1.0.0: source-available, free for noncommercial use. Commercial use needs a license from the author. Not open source.',
  run: 'Desktop apps for macOS, Windows and Linux, a web app you host with Docker, and a terminal app, all on one backend.',
  localModels: 'Ollama, llama.cpp, LM Studio or any OpenAI-compatible server.',
  hostedModels: 'Anthropic, OpenAI, Mistral, GitHub Copilot, OpenRouter, OpenCode Zen, a ChatGPT or Mistral Vibe plan, or any OpenAI-compatible endpoint.',
  tools: 'MCP connectors, skills, sub-agents and hooks; it reads existing agent skills, commands and hooks where they already live.',
  coding: 'Code is a built-in mode: agentic sessions in a project folder, with permission rules, diffs and git.',
  voice: 'Dictation in the message box (since 0.10.0): the Mac’s own speech recognition on a Mac, Atelier’s own speech model elsewhere. It also generates speech, music and sound.',
  accounts: 'Server mode has accounts, roles, invites and sign-in through an identity provider (OIDC). The desktop app runs on its own with no account.',
  telemetry: 'None. The desktop app checks for new versions, and a report goes out only when you press Send.',
};

const ROWS = [
  ['licence', 'Licence'],
  ['run', 'Ways to run it'],
  ['localModels', 'Local models'],
  ['hostedModels', 'Hosted models'],
  ['tools', 'Tools and MCP'],
  ['coding', 'Coding in a project folder'],
  ['voice', 'Voice'],
  ['accounts', 'Accounts and teams'],
  ['telemetry', 'Telemetry'],
];
export const ROW_LABELS = Object.fromEntries(ROWS);
export const ROW_ORDER = ROWS.map(([key]) => key);

export const PAGES = [
  {
    slug: 'open-webui',
    name: 'Open WebUI',
    title: 'Atelier vs Open WebUI',
    description: 'How Atelier and Open WebUI differ: licence, desktop apps, coding mode, accounts and models. Facts checked on 16 November 2026.',
    short:
      'Open WebUI is a web platform for chat, documents and tools that you host with Docker or pip, with single sign-on, roles and a large plugin ecosystem. Atelier is a desktop-first workspace where Chat and Code share one backend, and Code works in a project folder. Both run local and hosted models.',
    about: [
      'Open WebUI describes itself as an extensible, self-hosted platform built to run entirely offline. It is far bigger than Atelier in community and ecosystem: about 159,000 stars on GitHub, with v0.13.3 the latest release when this page was checked.',
    ],
    facts: {
      licence:
        'The Open WebUI License: BSD-3-style, plus a clause that bars removing its branding unless you have 50 or fewer users in 30 days, written permission or an enterprise licence. Its docs say versions since v0.6.6 are not OSI-approved open source.',
      run: 'pip install, a Docker image, and desktop apps for macOS, Windows and Linux.',
      localModels: 'Ollama and OpenAI-compatible servers.',
      hostedModels: 'OpenAI-compatible APIs; its docs also name Anthropic, vLLM and others.',
      tools: 'Python tools, MCP (Streamable HTTP) and OpenAPI servers. Documents go through RAG with 13 vector databases and hybrid search.',
      coding: 'Open Terminal, a separate project, gives an agent files and a shell; v0.13.3 lets a chat pick a terminal and a working folder.',
      voice: 'Speech-to-text, text-to-speech and realtime voice calls.',
      accounts: 'Roles (RBAC), SSO with OIDC and LDAP, SCIM 2.0, multi-factor sign-in and admin usage dashboards.',
      telemetry: 'Not stated in its README or features page; it can export OpenTelemetry data for your own monitoring.',
    },
    strongerThem: [
      'The ecosystem: a very large community, many extensions and a documents pipeline with a choice of 13 vector databases.',
      'Enterprise identity: LDAP, SCIM, multi-factor sign-in and an enterprise licence option.',
      'Built for the browser first, so a team can use it without installing anything.',
    ],
    strongerUs: [
      'Code is a mode of the app, with permission rules, diffs and git in one window, rather than a separate project you connect.',
      'Desktop-first: Atelier runs on its own on your computer, and the same backend can be shared on a server later.',
      'Source-available under a plain, standard licence (PolyForm Noncommercial) with no branding condition.',
      'No telemetry, and every system prompt published in the docs.',
    ],
    chooseThem: ['You want a large, web-first platform for a team, with SSO, LDAP and many integrations.', 'Documents and retrieval are the main job.'],
    chooseUs: ['You want one app for conversations and for coding in your project folders.', 'You want a desktop app that also works as a server.'],
    sources: [
      ['Open WebUI on GitHub', 'https://github.com/open-webui/open-webui'],
      ['Open WebUI License', 'https://raw.githubusercontent.com/open-webui/open-webui/main/LICENSE'],
      ['Open WebUI licence documentation', 'https://docs.openwebui.com/license'],
      ['Open WebUI features', 'https://docs.openwebui.com/features/'],
      ['Open WebUI latest release', 'https://github.com/open-webui/open-webui/releases/latest'],
    ],
  },
  {
    slug: 'librechat',
    name: 'LibreChat',
    title: 'Atelier vs LibreChat',
    description: 'How Atelier and LibreChat differ: licence, desktop apps, agents, code execution and accounts. Facts checked on 16 November 2026.',
    short:
      'LibreChat is an MIT-licensed web app that brings many AI providers into one chat interface, with agents, MCP, a sandboxed code interpreter and an admin panel. It has no desktop app. Atelier adds desktop apps for macOS, Windows and Linux and a Code mode that works in a project folder, under a noncommercial licence.',
    about: [
      'LibreChat describes itself as an enhanced ChatGPT clone and brings all your AI conversations into one customizable interface. It has about 47,000 stars on GitHub; its newest releases (v0.8.8 and v0.8.9-rc1) were marked as pre-releases when this page was checked.',
    ],
    facts: {
      licence: 'MIT.',
      run: 'Docker, npm and a Helm chart. It is a self-hosted web application, not a desktop app.',
      localModels: 'Ollama, Apple MLX, koboldcpp and other local servers it lists.',
      hostedModels: 'Anthropic, AWS Bedrock, OpenAI, Azure OpenAI, Google, Vertex AI, Mistral, Groq, OpenRouter and custom OpenAI-compatible endpoints.',
      tools: 'Agents, MCP, skills, sub-agents, a sandboxed Code Interpreter API (Python, JavaScript, Go, Rust and more), web search and artifacts.',
      coding: 'Attached workspaces, which it labels highly experimental, let agents read, search and edit files and run commands, with Ask, Allow or Deny for writes and commands.',
      voice: 'Speech-to-text and text-to-speech through OpenAI, Azure OpenAI and ElevenLabs.',
      accounts: 'An admin panel with users, groups and roles; OAuth2, LDAP and email sign-in; its site also lists SAML and two-factor sign-in.',
      telemetry: 'Not stated in its README; it can export OpenTelemetry and Langfuse data for your own monitoring.',
    },
    strongerThem: [
      'A permissive MIT licence that allows commercial use.',
      'A sandboxed code interpreter that runs code in many languages, and a very wide list of hosted providers.',
      'Built for hosting: Helm chart, admin panel and several sign-in methods.',
    ],
    strongerUs: [
      'Native desktop apps for macOS, Windows and Linux, and a terminal app, besides the web app.',
      'Code mode for project folders is a built-in part of the app, not an experimental add-on.',
      'One backend serves the desktop app and the server, so a conversation can start on your laptop and move to a shared server.',
      'No telemetry, and every system prompt published in the docs.',
    ],
    chooseThem: ['You need a permissive licence, or you plan commercial use.', 'You want a web-only deployment with a large provider list and a sandboxed code interpreter.'],
    chooseUs: ['You want desktop apps as well as a server.', 'You want an agent that works in your project folders as a normal part of the app.'],
    sources: [
      ['LibreChat on GitHub', 'https://github.com/LibreChat-AI/LibreChat'],
      ['LibreChat licence', 'https://raw.githubusercontent.com/danny-avila/LibreChat/main/LICENSE'],
      ['LibreChat documentation', 'https://www.librechat.ai/docs'],
      ['LibreChat website', 'https://librechat.ai/'],
      ['LibreChat releases', 'https://github.com/LibreChat-AI/LibreChat/releases/latest'],
    ],
  },
  {
    slug: 'lm-studio',
    name: 'LM Studio',
    title: 'Atelier vs LM Studio',
    description: 'How Atelier and LM Studio differ: running models versus using them, licence, servers and coding mode. Facts checked on 16 November 2026.',
    short:
      'LM Studio is a proprietary desktop app that downloads and runs local models itself, with chat, document upload, MCP and a local API server. Atelier does not run models; it connects to the ones you already run, such as LM Studio, Ollama or llama.cpp, or to hosted providers, and adds Chat and Code in one workspace that can also run as a shared server.',
    about: [
      'LM Studio is a model runner first: its site says it is powered by its own runtime, with MLX and llama.cpp under the hood. The two are often used together, since Atelier can talk to LM Studio’s local server.',
    ],
    facts: {
      licence: 'Proprietary. Its terms grant a license for personal or internal business use.',
      run: 'Desktop apps for macOS (Apple silicon only, macOS 14 or newer), Windows (x64 and ARM) and Linux (x64 and ARM64). A headless daemon, llmster, can run on a Linux server, and a local API server listens on localhost:1234.',
      localModels: 'It downloads and runs models itself, with llama.cpp and MLX.',
      hostedModels: 'Not stated on the pages read.',
      tools: 'An MCP host since version 0.3.17, with local and remote servers, and document upload with RAG.',
      coding: 'Bionic, which its site calls an agent for work and code; a project-folder coding mode is not described on its site.',
      voice: 'Real-time voice transcription, processed locally.',
      accounts: 'Not stated on the pages read.',
      telemetry: 'Not stated for the app; its cloud services are described as zero data retention.',
    },
    strongerThem: [
      'It runs the models itself: download, load and tune them in one place, including MLX on Apple silicon.',
      'A polished desktop experience for people who only want local models.',
    ],
    strongerUs: [
      'Atelier works with any model server, hosted or local, and with several at once.',
      'Code mode for project folders, and a server mode with accounts for sharing one setup with a team.',
      'Source-available, so you can read what it does; every system prompt is published.',
      'It runs on Intel Macs, which LM Studio does not support.',
    ],
    chooseThem: ['You want one app that downloads and runs local models.', 'You work alone and only on a Mac with Apple silicon, Windows or Linux.'],
    chooseUs: ['You already run models in Ollama, llama.cpp or LM Studio and want a better workspace on top.', 'You want to mix local and hosted models, or share the setup with a team.'],
    sources: [
      ['LM Studio', 'https://lmstudio.ai/'],
      ['LM Studio terms', 'https://lmstudio.ai/terms'],
      ['LM Studio system requirements', 'https://lmstudio.ai/docs/app/system-requirements'],
      ['LM Studio, llmster and lms', 'https://lmstudio.ai/docs/app/basics/lmstudio-vs-llmster-vs-lms'],
      ['LM Studio MCP', 'https://lmstudio.ai/docs/app/mcp'],
    ],
  },
  {
    slug: 'anythingllm',
    name: 'AnythingLLM',
    title: 'Atelier vs AnythingLLM',
    description: 'How Atelier and AnythingLLM differ: documents versus coding, licence, telemetry, desktop and Docker. Facts checked on 16 November 2026.',
    short:
      'AnythingLLM is an MIT-licensed all-in-one app built around your documents: it runs as a desktop app or in Docker, with a choice of vector databases, agents with skills and MCP. Atelier is built around conversations and coding in project folders, with desktop apps, a server and no telemetry, under a noncommercial licence.',
    about: [
      'AnythingLLM calls itself the all-in-one AI application: documents in, answers out, with agents on top. It has about 68,000 stars on GitHub, and v1.19.0 was the latest release when this page was checked.',
    ],
    facts: {
      licence: 'MIT.',
      run: 'Desktop apps for macOS, Windows and Linux, Docker, a bare-metal install, one-click cloud templates, a mobile app and a hosted instance.',
      localModels: 'Any llama.cpp-compatible model, Ollama, LM Studio, LocalAI and KoboldCPP.',
      hostedModels: 'OpenAI, Anthropic, Azure, Bedrock, Gemini and others.',
      tools: 'Agents with skills (web browsing, file system, SQL), no-code agent flows, scheduled jobs and MCP compatibility. Documents use RAG with LanceDB by default and many other vector databases.',
      coding: 'A file-system agent skill; a project-folder coding mode is not described in its README.',
      voice: 'Speech-to-text (built in or OpenAI) and text-to-speech (browser, Piper, OpenAI, ElevenLabs).',
      accounts: 'Multi-user and white-labelling in the Docker version only.',
      telemetry: 'It has an anonymous telemetry feature (PostHog) that you can turn off with DISABLE_TELEMETRY or in the app’s privacy settings.',
    },
    strongerThem: [
      'An MIT licence that allows commercial use.',
      'Documents are the centre: a choice of vector databases, and a ready-made path from files to answers.',
      'A mobile app and one-click cloud templates.',
    ],
    strongerUs: [
      'Code mode for project folders, with permission rules, diffs and git.',
      'Desktop and server share one backend, so the desktop app can also be the server.',
      'No telemetry at all, and every system prompt published in the docs.',
    ],
    chooseThem: ['Chatting with your own documents is the main job.', 'You need a permissive licence, a mobile app or a hosted instance.'],
    chooseUs: ['Coding in project folders is a main job next to chat.', 'You want no telemetry and a desktop app that can also serve a team.'],
    sources: [
      ['AnythingLLM on GitHub', 'https://github.com/Mintplex-Labs/anything-llm'],
      ['AnythingLLM licence', 'https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/LICENSE'],
      ['AnythingLLM documentation', 'https://docs.anythingllm.com/'],
      ['AnythingLLM website', 'https://anythingllm.com/'],
      ['AnythingLLM latest release', 'https://github.com/Mintplex-Labs/anything-llm/releases/latest'],
    ],
  },
];

/** The hub's table: one short line per project, for the two without a page of their own as well. */
export const HUB = [
  {
    name: 'Atelier',
    licence: 'PolyForm Noncommercial (source-available)',
    run: 'Desktop apps, Docker server, terminal app',
    agent: 'Code mode in project folders',
    accounts: 'Server mode: accounts, roles, OIDC',
    telemetry: 'None',
  },
  {
    name: 'Open WebUI',
    slug: 'open-webui',
    licence: 'Open WebUI License (BSD-3-style with a branding clause)',
    run: 'Docker, pip, desktop apps',
    agent: 'Open Terminal (separate project)',
    accounts: 'Roles, SSO, LDAP, SCIM',
    telemetry: 'Not stated',
  },
  {
    name: 'LibreChat',
    slug: 'librechat',
    licence: 'MIT',
    run: 'Docker, npm, Helm; web only',
    agent: 'Agents, code interpreter, experimental workspaces',
    accounts: 'Admin panel, roles, OAuth2, LDAP',
    telemetry: 'Not stated',
  },
  {
    name: 'LM Studio',
    slug: 'lm-studio',
    licence: 'Proprietary (personal or internal business use)',
    run: 'Desktop apps, headless daemon',
    agent: 'Bionic agent',
    accounts: 'Single user',
    telemetry: 'Not stated for the app',
  },
  {
    name: 'AnythingLLM',
    slug: 'anythingllm',
    licence: 'MIT',
    run: 'Desktop apps, Docker, mobile app',
    agent: 'Agents with skills, MCP',
    accounts: 'Multi-user in Docker',
    telemetry: 'Anonymous, can be turned off',
  },
  {
    name: 'Jan',
    licence: 'Apache 2.0',
    run: 'Desktop apps for Windows, macOS and Linux',
    agent: 'Jan Agent, MCP',
    accounts: 'Not stated',
    telemetry: 'Not stated',
    source: ['Jan on GitHub', 'https://github.com/janhq/jan'],
  },
  {
    name: 'Msty',
    licence: 'Proprietary; Studio Free for individual work, paid tiers',
    run: 'Desktop apps, web and team deployment in paid tiers',
    agent: 'Agent mode',
    accounts: 'SSO and roles in Teams',
    telemetry: 'States zero product telemetry',
    source: ['Msty', 'https://msty.ai/'],
  },
];

export const HUB_SOURCES = [
  ['Jan on GitHub', 'https://github.com/janhq/jan'],
  ['Jan website', 'https://jan.ai/'],
  ['Msty pricing', 'https://msty.ai/pricing/'],
  ['Msty Studio', 'https://msty.ai/products/studio/'],
];
