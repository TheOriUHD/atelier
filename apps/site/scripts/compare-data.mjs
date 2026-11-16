/**
 * What the comparison pages (/compare/) say. Every fact about another project comes from its own README, docs, licence or
 * terms, read on `CHECKED`; where a page didn't say something it is left out, not guessed. Change a fact here, run
 * `node apps/site/scripts/seo.mjs`, and commit the pages it writes (a test checks they are up to date).
 *
 * The message of the pages: Atelier is easy to start and still powerful. Ease is shown as steps and settings the other
 * project's own documentation asks for, not as adjectives.
 */

export const CHECKED = '2026-11-16';
export const CHECKED_TEXT = '16 November 2026';
export const SITE = 'https://atelierhq.dev';

/** Atelier's own side of every row (from its README and docs). */
export const ATELIER = {
  start: 'Download the app and open it: choose “Run on this computer” and type your name. No Docker, no config files, no account. The macOS app is signed and notarized, so it opens like any other app.',
  connect: 'It finds Ollama, llama.cpp and LM Studio on their usual ports, and API keys set in the environment. Set up opens the provider form already filled in.',
  updates: 'The desktop app downloads new versions by itself and installs them when you restart it. A server updates when an admin presses Update server, or with docker compose pull.',
  help: 'A troubleshooting page, Copy diagnostics in Settings, and a report button (F1) that sends a screenshot and diagnostics only when you press Send.',
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
  ['start', 'Getting started'],
  ['connect', 'Connecting your models'],
  ['updates', 'Updating'],
  ['help', 'When something goes wrong'],
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

/** What Atelier keeps however easy it is to start: shown on every comparison page. */
export const POWER = [
  'Chat and Code in one app: artifacts, projects, memory, web research, tasks that run in the background and sub-agents, and Code sessions in your project folders with permission rules, diffs and git.',
  'MCP connectors, skills, hooks and plugins, and it reads existing agent skills, commands and hooks where they already live.',
  'Image, video and audio generation, and dictation (the Mac’s own recognition on a Mac, Atelier’s own speech model elsewhere).',
  'Computer use, co-op sessions with other people, Remote Control of a session on another of your computers, and a terminal app.',
  'One backend for all of it: the desktop app can be the server for a team, with accounts, roles and sign-in through your identity provider.',
];

export const PAGES = [
  {
    slug: 'open-webui',
    name: 'Open WebUI',
    hubLine: 'Both are powerful. The difference is the setup: Open WebUI is built to be hosted with Docker or pip, Atelier installs like an app.',
    title: 'Atelier vs Open WebUI',
    metaTitle: 'Atelier vs Open WebUI: an Open WebUI alternative that is easy to start',
    description: 'Atelier vs Open WebUI: both are powerful, but Atelier starts with a download, not Docker and config files. Setup, updates and licence compared. Facts checked on 16 November 2026.',
    short:
      'Both are powerful and both run local and hosted models. The difference is the effort around them. Atelier installs like any app, with no Docker, config files or account, finds Ollama, llama.cpp and LM Studio by itself and downloads its own updates. Open WebUI is built to be hosted: Docker or pip, then connections and settings, with a large ecosystem behind it.',
    about: [
      'Open WebUI describes itself as an extensible, self-hosted platform built to run entirely offline. It is far bigger than Atelier in community and ecosystem: about 159,000 stars on GitHub, with v0.13.3 the latest release when this page was checked. It also has a desktop app, which installs Open WebUI on your computer and starts it for you.',
    ],
    facts: {
      start:
        'Docker: make a secret key with openssl, then run one docker run command (port, host mapping, data volume, secret key, image). Or pip install with Python 3.11 or 3.12. Or its desktop app, which needs an internet connection and 5 GB or more of disk.',
      connect:
        'It tries to connect to Ollama itself. From Docker the address is host.docker.internal, or you use --network=host, and Ollama on the host must listen beyond 127.0.0.1 (OLLAMA_HOST=0.0.0.0). Other providers go in Settings › Connections with a URL and a key.',
      updates:
        'Docker: remove the container, pull the image and run the command again. pip: pip install -U. The desktop app updates on quit once you turn automatic updates on. Its docs say to back up first, because migrations are one-way.',
      help: 'Thirteen troubleshooting guides in its docs: connection errors, Docker startup, audio, RAG, SSO, web search, performance and more.',
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
    ],
    strongerUs: [
      'Nothing to host to start: download, open, type your name. No Docker, no Python, no config files, no account.',
      'It finds the models you already run and fills in the provider form for you.',
      'It looks after itself: the desktop app downloads its own updates, and Settings can copy diagnostics or send a report with a screenshot when you press Send.',
      'Code is a built-in mode, with permission rules, diffs and git, rather than a separate project you connect.',
      'No telemetry, and every system prompt published in the docs.',
    ],
    chooseThem: ['You want a large platform to host for a team, with SSO, LDAP and many integrations.', 'You are comfortable running Docker or Python and configuring it, and documents and retrieval are the main job.'],
    chooseUs: ['You want it working in minutes without administering anything.', 'You want conversations and coding in project folders in one app, and a server later if you need one.'],
    sources: [
      ['Open WebUI on GitHub', 'https://github.com/open-webui/open-webui'],
      ['Open WebUI quick start', 'https://docs.openwebui.com/getting-started/quick-start/'],
      ['Open WebUI: starting with Ollama', 'https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama'],
      ['Open WebUI: connection errors', 'https://docs.openwebui.com/troubleshooting/connection-error'],
      ['Open WebUI: troubleshooting guides', 'https://docs.openwebui.com/troubleshooting/'],
      ['Open WebUI: updating', 'https://docs.openwebui.com/getting-started/updating'],
      ['Open WebUI desktop app', 'https://github.com/open-webui/desktop'],
      ['Open WebUI License', 'https://raw.githubusercontent.com/open-webui/open-webui/main/LICENSE'],
      ['Open WebUI licence documentation', 'https://docs.openwebui.com/license'],
      ['Open WebUI features', 'https://docs.openwebui.com/features/'],
      ['Open WebUI latest release', 'https://github.com/open-webui/open-webui/releases/latest'],
    ],
  },
  {
    slug: 'librechat',
    name: 'LibreChat',
    hubLine: 'Both connect to many models. LibreChat is a Docker, .env and YAML setup; Atelier installs like an app.',
    title: 'Atelier vs LibreChat',
    metaTitle: 'Atelier vs LibreChat: a LibreChat alternative that is easy to start',
    description: 'Atelier vs LibreChat: both are powerful, but Atelier starts with a download, not Docker, .env and YAML files. Setup, updates and licence compared. Facts checked on 16 November 2026.',
    short:
      'Both are powerful and both connect to many models. Atelier installs like any app, with no Docker, config files or account, and finds your local models by itself. LibreChat is an MIT-licensed web app you host with Docker, configured through .env and librechat.yaml, with agents, MCP, a sandboxed code interpreter and an admin panel.',
    about: [
      'LibreChat describes itself as an enhanced ChatGPT clone and brings all your AI conversations into one customizable interface. It has about 47,000 stars on GitHub; its newest releases (v0.8.8 and v0.8.9-rc1) were marked as pre-releases when this page was checked. It has no desktop app.',
    ],
    facts: {
      start:
        'Install Git and Docker, clone the repository, copy .env.example to .env and run docker compose up. Then open localhost:3080 and register; the first account becomes admin. Its docs say the stack needs at least 1 GiB of RAM and runs MongoDB, Meilisearch and a RAG API with PostgreSQL.',
      connect:
        'API keys go in .env, or each user enters their own. A custom endpoint such as Ollama needs librechat.yaml, .env and a docker-compose.override.yml, and from Docker the address is host.docker.internal or the host’s network address. An endpoint missing a required field is dropped without an error.',
      updates:
        'Its docs give manual steps for Docker: stop the stack, remove the images, git pull, docker compose pull and start again. The README says to read the changelog for breaking changes first.',
      help: 'Docs sections for port conflicts, containers that crash on startup, missing environment variables, endpoints that don’t appear and an empty Ollama model list.',
      licence: 'MIT.',
      run: 'Docker, npm and a Helm chart. It is a self-hosted web application, not a desktop app.',
      localModels: 'Ollama, Apple MLX, koboldcpp and other local servers it lists.',
      hostedModels: 'Anthropic, AWS Bedrock, OpenAI, Azure OpenAI, Google, Vertex AI, Mistral, Groq, OpenRouter and custom OpenAI-compatible endpoints.',
      tools:
        'Agents, MCP, skills, sub-agents, a sandboxed Code Interpreter API (Python, JavaScript, Go, Rust and more; its docs say an admin must deploy a separate service for it), web search and artifacts.',
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
      'Nothing to host to start: download, open, type your name. No Docker, no .env, no YAML, no account.',
      'It finds Ollama, llama.cpp and LM Studio by itself and fills in the provider form. No override files, no container networking.',
      'The desktop app downloads its own updates instead of a list of manual steps.',
      'Code is a built-in mode for project folders, not an experimental add-on, and the same backend can be shared on a server later.',
      'No telemetry, and every system prompt published in the docs.',
    ],
    chooseThem: ['You need a permissive licence, or you plan commercial use.', 'You want a web-only deployment with a large provider list and a sandboxed code interpreter, and you are happy to run Docker.'],
    chooseUs: ['You want it working in minutes without administering anything.', 'You want desktop apps as well as a server, and an agent that works in your project folders as a normal part of the app.'],
    sources: [
      ['LibreChat on GitHub', 'https://github.com/LibreChat-AI/LibreChat'],
      ['LibreChat: Docker install', 'https://www.librechat.ai/docs/local/docker'],
      ['LibreChat: first chat', 'https://www.librechat.ai/docs/quick_start/first_chat'],
      ['LibreChat: custom endpoints', 'https://www.librechat.ai/docs/quick_start/custom_endpoints'],
      ['LibreChat: Ollama', 'https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints/ollama'],
      ['LibreChat: code interpreter', 'https://www.librechat.ai/docs/features/code_interpreter'],
      ['LibreChat licence', 'https://raw.githubusercontent.com/danny-avila/LibreChat/main/LICENSE'],
      ['LibreChat documentation', 'https://www.librechat.ai/docs'],
      ['LibreChat website', 'https://librechat.ai/'],
      ['LibreChat releases', 'https://github.com/LibreChat-AI/LibreChat/releases/latest'],
    ],
  },
  {
    slug: 'lm-studio',
    name: 'LM Studio',
    hubLine: 'LM Studio runs models. Atelier is the workspace on top of them, LM Studio’s included.',
    title: 'Atelier vs LM Studio',
    metaTitle: 'Atelier vs LM Studio: the workspace on top of your local models',
    description: 'Atelier vs LM Studio: LM Studio runs models, Atelier is the easy, powerful workspace on top of them. Setup, licence, servers and coding mode. Facts checked on 16 November 2026.',
    short:
      'LM Studio is a proprietary desktop app that downloads and runs local models itself, with chat, document upload, MCP and a local API server. Atelier does not run models; it is the workspace on top of the ones you already run, LM Studio’s included. It finds LM Studio by itself, and adds Chat and Code in one app that can also be a shared server.',
    about: [
      'LM Studio is a model runner first: its site says it is powered by its own runtime, with MLX and llama.cpp under the hood. The two are often used together, since Atelier detects LM Studio’s local server on its default port.',
    ],
    facts: {
      start: 'A desktop app that downloads and runs models itself.',
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
      'It is a workspace, not a model runner: it works with any model server, hosted or local, and with several at once.',
      'It finds LM Studio, Ollama and llama.cpp by itself and fills in the provider form.',
      'Code mode for project folders, and a server mode with accounts for sharing one setup with a team.',
      'Source-available, so you can read what it does; every system prompt is published.',
      'It runs on Intel Macs, which LM Studio does not support.',
    ],
    chooseThem: ['You want one app that downloads and runs local models.', 'You work alone and only on a Mac with Apple silicon, Windows or Linux.'],
    chooseUs: ['You already run models in Ollama, llama.cpp or LM Studio and want an easy, more powerful workspace on top.', 'You want to mix local and hosted models, or share the setup with a team.'],
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
    hubLine: 'Both start from a desktop app. AnythingLLM is built around documents, Atelier around conversations and coding.',
    title: 'Atelier vs AnythingLLM',
    metaTitle: 'Atelier vs AnythingLLM: easy to start, built for chat and coding',
    description: 'Atelier vs AnythingLLM: both start from a desktop app; Atelier adds Code mode, no telemetry and a shared server. Setup, licence and telemetry compared. Facts checked on 16 November 2026.',
    short:
      'AnythingLLM is an MIT-licensed all-in-one app built around your documents: a desktop app or Docker, with a choice of vector databases, agents with skills and MCP. Atelier is built around conversations and coding in project folders, is just as quick to start, and adds no telemetry and a server mode that shares the same app.',
    about: [
      'AnythingLLM calls itself the all-in-one AI application: documents in, answers out, with agents on top. It has about 68,000 stars on GitHub, and v1.19.0 was the latest release when this page was checked.',
    ],
    facts: {
      start: 'A desktop app for macOS, Windows and Linux, or Docker.',
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
      'Code mode for project folders, with permission rules, diffs and git, next to Chat.',
      'It finds Ollama, llama.cpp and LM Studio by itself and fills in the provider form.',
      'The desktop app and the server are the same app on one backend, so the desktop app can also serve a team.',
      'No telemetry at all, and every system prompt published in the docs.',
    ],
    chooseThem: ['Chatting with your own documents is the main job.', 'You need a permissive licence, a mobile app or a hosted instance.'],
    chooseUs: ['Conversations and coding in project folders are the main jobs, and you want them easy to start and powerful to keep using.', 'You want no telemetry and a desktop app that can also serve a team.'],
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
    start: 'Download, open, type your name',
    licence: 'PolyForm Noncommercial (source-available)',
    run: 'Desktop apps, Docker server, terminal app',
    agent: 'Code mode in project folders',
    accounts: 'Server mode: accounts, roles, OIDC',
    telemetry: 'None',
  },
  {
    name: 'Open WebUI',
    slug: 'open-webui',
    start: 'A docker run command or pip, or a desktop installer',
    licence: 'Open WebUI License (BSD-3-style with a branding clause)',
    run: 'Docker, pip, desktop apps',
    agent: 'Open Terminal (separate project)',
    accounts: 'Roles, SSO, LDAP, SCIM',
    telemetry: 'Not stated',
  },
  {
    name: 'LibreChat',
    slug: 'librechat',
    start: 'Git, Docker, a .env file and docker compose',
    licence: 'MIT',
    run: 'Docker, npm, Helm; web only',
    agent: 'Agents, code interpreter, experimental workspaces',
    accounts: 'Admin panel, roles, OAuth2, LDAP',
    telemetry: 'Not stated',
  },
  {
    name: 'LM Studio',
    slug: 'lm-studio',
    start: 'A desktop app that runs models itself',
    licence: 'Proprietary (personal or internal business use)',
    run: 'Desktop apps, headless daemon',
    agent: 'Bionic agent',
    accounts: 'Not stated',
    telemetry: 'Not stated for the app',
  },
  {
    name: 'AnythingLLM',
    slug: 'anythingllm',
    start: 'A desktop app, or Docker',
    licence: 'MIT',
    run: 'Desktop apps, Docker, mobile app',
    agent: 'Agents with skills, MCP',
    accounts: 'Multi-user in Docker',
    telemetry: 'Anonymous, can be turned off',
  },
  {
    name: 'Jan',
    start: 'A desktop app',
    licence: 'Apache 2.0',
    run: 'Desktop apps for Windows, macOS and Linux',
    agent: 'Jan Agent, MCP',
    accounts: 'Not stated',
    telemetry: 'Not stated',
  },
  {
    name: 'Msty',
    start: 'A desktop app',
    licence: 'Proprietary; Studio Free for individual work, paid tiers',
    run: 'Desktop apps, web and team deployment in paid tiers',
    agent: 'Agent mode',
    accounts: 'SSO and roles in Teams',
    telemetry: 'States zero product telemetry',
  },
];

export const HUB_SOURCES = [
  ['Jan on GitHub', 'https://github.com/janhq/jan'],
  ['Jan website', 'https://jan.ai/'],
  ['Msty pricing', 'https://msty.ai/pricing/'],
  ['Msty Studio', 'https://msty.ai/products/studio/'],
];
