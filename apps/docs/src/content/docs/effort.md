---
title: Effort, Thinking and Ultracode
description: How the effort control works, what each level asks of each kind of model, the Thinking switch, provider-fixed stops, and Ultracode's parallel sub-agents.
---

Effort is how hard the model works on a request: how long it thinks, how much it checks, how many steps it takes. You set it next to the model picker in Chat, Cowork and Code. Higher levels give better results on hard problems but take longer and use more tokens. In Code the last stop is **Ultracode**, which adds parallel sub-agents.

## The levels

Every model offers the same five levels, Low to Max, plus Ultracode in Code (except where a provider fixes its own stops, [below](#models-with-their-own-stops)). What each level sends depends on what the model can do ([below](#what-a-level-sends-to-each-kind-of-model)). The table shows the popover's help for a level the model's own setting has; for a level it doesn't, the help says what the model is asked instead.

| Level | Help text in the popover |
|---|---|
| **Low** | Fastest replies, fewest tool calls. Quick questions and small, well-defined edits. |
| **Medium** | Balanced depth and speed for everyday work with a clear scope. |
| **High** | More thinking and checking. Bug fixes and changes where edge cases matter. |
| **Extra** | Deep reasoning for long, multi-step work. Slower and uses more tokens. |
| **Max** | Everything the model has, for the hardest problems. Can be slow and costly. |
| **Ultracode** (Code only) | Plans each task, investigates in parallel with sub-agents and has others check the results, within a per-request budget. Much slower, far more tokens. |

**Max** carries a warning mark: **Max Usage, consumes 3.5X more Tokens**. So does **Ultracode**: **Ultracode Usage, consumes far more Tokens and takes much longer**. Both texts are fixed in the app; the 3.5X is not a measurement of your model.

## The effort control

The chip with the level's name sits in the message box footer, right after the model picker. Click it, or press **⌘⇧E** (**Ctrl+Shift+E** on Windows and Linux), to open the popover:

- The current level's name, with a **?** that explains it.
- A slider from **Faster** to **Smarter**, one detent per level. Drag it, or use the arrow keys after the shortcut has focused it.
- The level marked **Recommended**.
- For models that only think on or off, a **Thinking** switch ([below](#the-thinking-switch)).

<!-- screenshot: the effort popover open on a model with a Thinking switch, and the same popover on Ultracode in Code -->

An existing session changes level from your next message; a reply already running is not affected. If the change can't be saved, a toast says **Couldn’t change effort**.

### How a session gets its level

1. The level the session stores, if you picked one.
2. Otherwise the model's **Recommended** level for the mode (Chat, Cowork or Code): the model's own recommendation where Atelier knows one, else **Medium**.
3. That level is moved onto what the model offers. A stored level the model doesn't have (after you switch models, or an admin switches Ultracode off) becomes the nearest lower one. Ultracode where it isn't offered is Extra in Code and Max elsewhere.
4. The request carries the stop moved to the next lower level the model's own setting has.

There is no per-person default level.

## What a level sends to each kind of model

| Provider | What the level becomes |
|---|---|
| **Anthropic**, current models | Adaptive thinking with summarized output and an effort of `low`, `medium`, `high`, `xhigh` (Extra) or `max`, moved to the nearest level the model lists. |
| **Anthropic**, models up to the 4.5 generation | A thinking budget: Low 4,000, Medium 10,000, High 20,000, Extra 32,000, Max 48,000 tokens, at most 1,024 under the reply's output limit. With less than that left, no thinking. |
| **OpenAI**, **ChatGPT Plan** | A reasoning effort of low, medium or high. Extra and Max both ask for the API's top setting (`xhigh`), moved to what the model accepts. Reasoning summaries show as thinking. |
| **OpenRouter**, **OpenCode Zen**, **LM Studio**, other OpenAI-compatible servers | For models that report a reasoning setting: Low and Medium as they are, anything higher as High. Models that don't report one get nothing. |
| **Ollama** | A level for models that list levels (the gpt-oss family: low, medium, high). A model that only thinks on or off gets thinking on or off. A model without thinking gets nothing. |
| **llama.cpp** | What the model's chat template reads: `enable_thinking` on or off, or a `reasoning_effort` of low, medium or high. Atelier reads which one from the server. |
| **GitHub Copilot** | The **Auto** model uses the level to pick its routing profile: Low saves, Medium balances, High and above ask for the best. Other models get a reasoning effort as the OpenAI-compatible row. |
| **ChatGPT Chat** | ChatGPT's own stops, below. |

The output limit of a reply also grows with the level: 32,000 tokens up to Medium, 64,000 at High, the model's own maximum at Extra and above (never more than the model allows). On Anthropic budget models the thinking budget comes out of it.

### When the model has no matching setting

Some models can't express a level: one with no thinking, one that thinks only on or off, or one whose top level is below the one you chose (Max on a model that stops at High). Atelier then adds a short note to your message that says what the level asks for. The notes are published on [Context updates](/prompts/context-updates/):

| Level | What the model is asked |
|---|---|
| **Low** | Finish the whole request by the shortest sensible route; skip optional exploration and extras; no sub-agents for small things. |
| **Medium** | Nothing. The model answers as it usually does. |
| **High** | Think the problem through and check the result against what was asked. |
| **Extra** | Work step by step, try more than one approach, check each claim, look for edge cases. |
| **Max** | The most rigor it can: alternatives, verification of everything it can, a re-check of the final answer, and a plain statement of what it couldn't verify. |

A model with no thinking, or only a switch, gets these at every level but Medium. A model with its own levels gets a note for Low and for a level above its range. The note is announced when the level starts or changes, repeated every ten of your messages and after a compaction, and ended with a short note when you go back to a level that needs none. The popover's help says when this applies ("The model is asked to …").

Low gets its note on every model, including those with a native Low, so Low is token-efficient everywhere.

## The Thinking switch

Some local models can only think on or off. For those (Ollama thinking models without levels, llama.cpp templates with `enable_thinking`) the popover has a **Thinking** switch marked **Recommended**:

- On by default. Off sends the model no thinking at all.
- It hides from **Extra** upward, where thinking is always on.
- Set it **before the first message** of a new session and the choice becomes your default for new sessions. In an existing session it changes that session only.
- Sub-agents and side chats inherit the session's setting.
- If it can't be saved a toast says **Couldn’t change thinking**.

With the switch on, every level from Low to High sends the model "think", and the level's words do the rest. Models with levels of their own (gpt-oss on Ollama, Anthropic and OpenAI models) have no switch.

## Models with their own stops

Some providers fix the stops themselves. **ChatGPT Chat** reads the models and the stops of ChatGPT's own picker from the page (today **Instant**, **Medium**, **High**, **Extra High** and **Pro**, depending on the model and your plan). These replace the Low to Max scale:

| ChatGPT's stop | Stores as |
|---|---|
| Instant | Low |
| Medium | Medium |
| High | High |
| Extra High | Extra |
| Pro | Max |

A stop your plan locks isn't shown. The slider's names, help texts and warnings are ChatGPT's. Pro warns **Pro has its own, much smaller allowance than the other settings.** It is drawn like Ultracode, but only as a look: Pro sends Max and has none of Ultracode's behavior, and it doesn't depend on the admin's Ultracode switch. **Ultracode isn't offered** with these models. Atelier sets the page to the model and stop before each message when it differs. See [ChatGPT](/chatgpt/).

## Ultracode

Ultracode is the last stop in **Code**. It is a way of working at Extra, not a level of its own.

**What it asks of the model.** The model gets a note that Ultracode is on, and Atelier sends Extra to the provider. The note asks the model, for everything except small talk and trivial edits, to:

- work in phases (understand, plan, change, verify) and read each phase's results before the next;
- spread investigation and review across sub-agents, launching independent ones together, and make changes itself or through one writing sub-agent at a time whose brief names the files it owns;
- before it reports a finding or calls a change done, have a fresh sub-agent try to show it wrong, for at most 3 review rounds, stopping early when a round finds nothing new;
- treat a check that was already failing as pre-existing instead of chasing it.

Plan mode and the permission rules apply as usual: sub-agents ask you through the same prompts, and Plan mode still refuses edits (see [Permissions](/permissions/)).

**The budget.** One Ultracode request, meaning your message and everything it starts, may start up to **24 sub-agents**, counted across the whole tree, background sub-agents and the turns that report their results included. Past the budget the Agent tool answers **This request has used its sub-agent budget: it has started 24 sub-agents, the most one request may start, so no more will start. Finish the work with what you have.** The 24 is enforced; the 3 review rounds is a request to the model. Sub-agents work at Extra and don't start sub-agents of their own.

**When the model or mode can't run it.**

- A model whose own setting has no Extra runs at the nearest level it has (or with Thinking on) and is also asked for Extra's rigor in the note.
- A model without the Agent tool gets the notes without their sub-agent parts: it works in phases and checks its own work.
- Small models may start few sub-agents or none.
- ChatGPT Chat doesn't offer Ultracode.
- Chat and Cowork have no Ultracode; a session that carries it there runs at Max.

**Who switches it off.** An admin can turn Ultracode off with the **Ultracode** switch in **Settings › Admin › Code › Effort** (on by default). The stop disappears, and sessions that had chosen it run at Extra and are told in a short note that Ultracode is off.

**What it costs.** Each sub-agent has its own context and every check is another pass, so expect it to take much longer and use far more tokens than Extra, with the bill or your plan's allowance to match. Watch **Settings › Usage**. On a one-model local server, sub-agents queue behind each other (see [Code](/code/#sub-agents)), so Ultracode is slow there rather than parallel.

## Where the level goes

- **Sub-agents** run at the session's level; under Ultracode they run at Extra.
- **Side chats** (`/btw`) always run at Low, whatever the main session's level.
- **Titles, compaction summaries** and the [Auto mode](/permissions/#auto-mode) reviewer don't use your level: they ask for the lowest reasoning setting the model has, or none.

## Choosing a level

| If you are … | Start with |
|---|---|
| Asking a quick question, renaming something, making a small and well-defined edit | **Low** |
| Doing everyday work with a clear scope | **Medium** (the usual Recommended level) |
| Fixing a bug, changing code where edge cases matter, reviewing a diff | **High** |
| Starting a long refactor, debugging something that resists, working across many files | **Extra** |
| Stuck on the hardest problems and willing to wait | **Max** |
| Making a large, cross-cutting change where correctness matters more than speed or cost, and you will review the result | **Ultracode** |

- Raise the level when the model's answer is wrong or shallow, not by default. Each step up costs time and tokens on every request, tool calls included.
- A small local model gains less from Max than a large one. A larger context window, or a better model, helps more.
- Max and Ultracode on a hosted API bill the extra tokens. On a **ChatGPT Plan** they count against the plan's limits.
- Ultracode is for tasks worth a plan, a team of investigators and a review. For a one-line change it only adds cost.
- On a model with a **Thinking** switch, turning thinking off is the biggest saving for easy requests.
