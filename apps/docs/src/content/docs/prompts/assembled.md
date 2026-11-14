---
title: "Assembled prompts"
description: "The complete text a model receives in typical sessions, system blocks, notes and tool definitions, as downloads."
editUrl: false
---

<!-- GENERATED from packages/core/src/prompts/__snapshots__/prompts by packages/core/src/prompts/__fixtures__/publish-docs.ts. Do not edit; run `pnpm docs:generate`. -->

What a model really receives is more than the templates: the builder joins a core prompt, fragments, optional
safeguards, an `<env>` block, instruction files, skills and personalization, and the request also carries the tool
definitions. The files below are the complete assembled text of 48 typical sessions: every system block in
order (with the cache breakpoints marked), the notes on the first message, and the tools as JSON.

They are produced by the project’s test suite with fixed inputs (the date 2026-01-15 in Europe/Berlin, fake model
names, a fixed folder and a two-line `AGENTS.md`), and the suite fails when a template, a tool description or the
assembly changes without these files changing too, so they cannot drift from the code. In the repository they are in
[`packages/core/src/prompts/__snapshots__/prompts/`](https://github.com/TheOriUHD/atelier/blob/main/packages/core/src/prompts/__snapshots__/prompts).

Your own sessions add your folder, skills, memory and instruction files to these. The request inspector (Settings ›
Admin › Developer › Record provider requests) lists the requests sent to your model providers, but it never records
prompts or replies.

| Case | What it shows | Size |
|---|---|---|
| [`chat.full`](/prompts/assembled/chat.full.txt) | Chat, full tier, web search on: the baseline. | 34 KB |
| [`chat.full.no-web`](/prompts/assembled/chat.full.no-web.txt) | Chat with web search and fetch switched off by an administrator. | 28 KB |
| [`chat.full.project`](/prompts/assembled/chat.full.project.txt) | Chat inside a project: its instructions and files. | 34 KB |
| [`chat.full.organization`](/prompts/assembled/chat.full.organization.txt) | Chat with an administrator’s instructions for everyone. | 34 KB |
| [`chat.full.personality-technical`](/prompts/assembled/chat.full.personality-technical.txt) | Chat with a built-in personality selected (technical and earnest). | 35 KB |
| [`code.compact.personality-relaxed`](/prompts/assembled/code.compact.personality-relaxed.txt) | Code, compact tier, with a built-in personality selected (relaxed, more emoji). | 22 KB |
| [`chat.full.personality-custom`](/prompts/assembled/chat.full.personality-custom.txt) | Chat with a custom personality and a concise response style. | 35 KB |
| [`chat.full.personalization`](/prompts/assembled/chat.full.personalization.txt) | Chat with a name, a response style and the person’s own instructions. | 34 KB |
| [`chat.compact`](/prompts/assembled/chat.compact.txt) | Chat, compact tier. | 14 KB |
| [`chat.compact.prompted`](/prompts/assembled/chat.compact.prompted.txt) | Chat, compact tier, for a model that calls tools through text (prompted tool calls). | 11 KB |
| [`chat.full.sandbox`](/prompts/assembled/chat.full.sandbox.txt) | Chat with a conversation sandbox, where its file and command tools run until it has a folder. | 50 KB |
| [`chat.compact.sandbox`](/prompts/assembled/chat.compact.sandbox.txt) | Chat, compact tier, with a conversation sandbox. | 21 KB |
| [`chat.full.folder`](/prompts/assembled/chat.full.folder.txt) | Chat given one of the person’s folders: the file and command tools work there. | 51 KB |
| [`chat.full.memory`](/prompts/assembled/chat.full.memory.txt) | Chat for a person with memory, with the memory tools and digest. | 43 KB |
| [`chat.full.memory-explicit`](/prompts/assembled/chat.full.memory-explicit.txt) | Chat with memory where “Generate memory from chats” and chat search are off. | 40 KB |
| [`chat.compact.memory`](/prompts/assembled/chat.compact.memory.txt) | Chat, compact tier, with memory. | 20 KB |
| [`chat.full.computer`](/prompts/assembled/chat.full.computer.txt) | Chat in the desktop app with computer use on: the computer use tools. | 60 KB |
| [`chat.full.browser`](/prompts/assembled/chat.full.browser.txt) | Chat with computer use on and Atelier for Chrome connected: the Browser tool. | 63 KB |
| [`chat.full.images`](/prompts/assembled/chat.full.images.txt) | Chat with an image model: GenerateImage and how to use it. | 40 KB |
| [`code.full.images`](/prompts/assembled/code.full.images.txt) | Code with an image model: GenerateImage and SaveImage. | 58 KB |
| [`code.compact.images`](/prompts/assembled/code.compact.images.txt) | Code, compact tier, with an image model: the shorter GenerateImage schema. | 24 KB |
| [`chat.full.videos`](/prompts/assembled/chat.full.videos.txt) | Chat with a video model: GenerateVideo and how to use it. | 38 KB |
| [`code.full.videos`](/prompts/assembled/code.full.videos.txt) | Code with a video model: GenerateVideo and SaveVideo. | 56 KB |
| [`code.compact.videos`](/prompts/assembled/code.compact.videos.txt) | Code, compact tier, with a video model: the shorter GenerateVideo schema. | 23 KB |
| [`chat.full.audio`](/prompts/assembled/chat.full.audio.txt) | Chat with a sound model: GenerateAudio for speech, music and sound effects, and how to use it. | 40 KB |
| [`code.full.audio`](/prompts/assembled/code.full.audio.txt) | Code with a sound model: GenerateAudio and SaveAudio. | 58 KB |
| [`code.compact.audio`](/prompts/assembled/code.compact.audio.txt) | Code, compact tier, with a sound model: the shorter GenerateAudio schema. | 23 KB |
| [`code.compact.computer`](/prompts/assembled/code.compact.computer.txt) | Code, compact tier, with computer use on. | 26 KB |
| [`code.compact.browser`](/prompts/assembled/code.compact.browser.txt) | Code, compact tier, with computer use on and Atelier for Chrome connected. | 29 KB |
| [`code.full.desktop`](/prompts/assembled/code.full.desktop.txt) | Code, full tier, written from the desktop app: Preview opens web pages in its Browser pane. | 53 KB |
| [`code.compact.desktop`](/prompts/assembled/code.compact.desktop.txt) | Code, compact tier, written from the desktop app (Preview). | 22 KB |
| [`code.full.terminal`](/prompts/assembled/code.full.terminal.txt) | Code, full tier, written from the terminal app: no artifact pane, and the note saying where the person is. | 50 KB |
| [`code.full`](/prompts/assembled/code.full.txt) | Code, full tier: the baseline. | 51 KB |
| [`code.full.plan`](/prompts/assembled/code.full.plan.txt) | Code in plan mode. | 52 KB |
| [`code.full.scratch`](/prompts/assembled/code.full.scratch.txt) | Code started with No folder: a scratch folder of its own. | 50 KB |
| [`code.full.no-effort`](/prompts/assembled/code.full.no-effort.txt) | Code on a model without effort levels, web search off. | 46 KB |
| [`code.full.subagent`](/prompts/assembled/code.full.subagent.txt) | A sub-agent started by the Agent tool. | 27 KB |
| [`code.full.defined-agent`](/prompts/assembled/code.full.defined-agent.txt) | A sub-agent defined by an agent file with its own prompt. | 6 KB |
| [`code.compact`](/prompts/assembled/code.compact.txt) | Code, compact tier. | 21 KB |
| [`code.compact.prompted`](/prompts/assembled/code.compact.prompted.txt) | Code, compact tier, with prompted tool calls. | 17 KB |
| [`code.compact.connectors`](/prompts/assembled/code.compact.connectors.txt) | Code, compact tier, with three connectors of twenty tools each. | 40 KB |
| [`code.compact.budget`](/prompts/assembled/code.compact.budget.txt) | Code, compact tier, over the 16,000 character budget: how the builder trims the skill list, connectors and instruction files. | 22 KB |
| [`safeguards.chat.full`](/prompts/assembled/safeguards.chat.full.txt) | Chat with the administrator’s optional safeguards on. | 36 KB |
| [`safeguards.chat.compact`](/prompts/assembled/safeguards.chat.compact.txt) | Chat, compact tier, with safeguards on. | 15 KB |
| [`safeguards.code.full.all`](/prompts/assembled/safeguards.code.full.all.txt) | Code with every safeguard category on. | 55 KB |
| [`safeguards.code.compact.all`](/prompts/assembled/safeguards.code.compact.all.txt) | Code, compact tier, with every safeguard category on. | 22 KB |
| [`safeguards.chat.full.person-on`](/prompts/assembled/safeguards.chat.full.person-on.txt) | Chat where the person turned safeguards on for themselves. | 36 KB |
| [`safeguards.code.full.subagent`](/prompts/assembled/safeguards.code.full.subagent.txt) | A sub-agent inheriting the person’s safeguards (some categories on). | 29 KB |

## One file with everything

- [`atelier-prompts.md`](/prompts/atelier-prompts.md): every template in one Markdown file.
- [`atelier-prompts.json`](/prompts/atelier-prompts.json): the same as JSON (`templates`, `notes`, `tools`).
