---
title: Models
description: How the model list works in Atelier, from the picker and the defaults to per-model overrides for context length, tool calling, vision and prompt tier.
---

Every model Atelier can use is a `provider/model` pair: the provider's ID from [Providers](/providers/), a slash, and the id
the provider uses (`ollama/qwen3:8b`, `anthropic/claude-sonnet-5-5`). Providers report their models; Atelier works out what
each one can do, and you can correct it. This page covers the picker and the **Settings › Admin › Models** page admins use
to shape it.

## The model picker

The model name sits in the composer's footer, with the [effort](/effort/) control beside it, in Chat, Cowork and Code. Typing
`/model` opens the same list.

- **What it lists:** visible models from enabled providers.
- **Grouping and order:** grouped by provider (the name shows only when more than one provider has visible models). Favorites
  come first, then models in their configured order, then by name. A favorite pulls its provider's group to the top.
- **The line under each name** gives the context size, then `vision`, `reasoning`, `prompted tools` or `no tools`, and
  `free`, for example `200K context · vision · reasoning`.
- **Changing the model** in an existing conversation applies from the next message.
- **Nothing to pick:** an admin sees **Add a provider**; everyone else sees **No models available** ("Ask an admin to connect
  a provider.").

Admins decide what the list contains; other accounts only receive the visible models.

## Which model a new conversation starts on

| Where | It starts on |
|---|---|
| **Chat** | Your **Default model** in **Settings › General**, if it is still visible. Otherwise the admin's **Default model for everyone**, otherwise the first visible model. |
| **Cowork** and **Code** | The admin's **Default model for everyone**, otherwise the first visible model. |

The **Default model** in Settings › General is yours alone and applies to new chats (unset: "Server default (*model name*)").
The admin's **Default model for everyone** (unset: "First available model") is under **Settings › Admin › Models › Defaults**.

A default can also be set for Cowork (`work`) or Code (`code`) alone in the settings file (`models.defaults.work`,
`models.defaults.code`); that one wins over **Default model for everyone** for its own mode. Settings does not offer it.

A default whose model is gone (provider removed or switched off, or the model hidden) shows a warning, and new conversations
fall back to the next choice. Settings › General says "This model is no longer available. New chats start with the server
default (*model*) until you choose another."; Admin › Models says the same with "the first available model".

Connecting your first provider on the setup screen sets **Default model for everyone** to that provider's first model, unless
a default exists.

## Small model

**Small model** (Settings › Admin › Models › Defaults) does the short background jobs:

- conversation **titles**,
- the **summaries** written when a long conversation is compacted,
- **memory** updates and imports,
- the answers WebFetch extracts from a page,
- Auto mode's **review** of actions, when the conversation's own model is ChatGPT Chat (see [ChatGPT](/chatgpt/)).

Unset, it reads **Same as the chat**: each conversation's own model does the work. If the small model is gone, hidden or its
provider is off, titles, summaries and page answers use the conversation's model; memory tries the small model, the
conversation's model, your default model, the server's default and the first available model in turn.

When the small model and the conversation's model are on the same server and that server holds one model at a time (the
default for a model server on your computer or network), Atelier uses the conversation's model for these jobs instead,
because swapping models costs more than it saves. The small model is used when it lives on another server, or when **Models
at once** on the provider is 2 or more. Sub-agents with their own model follow the same rule. See
[Sharing a GPU](/providers/#sharing-a-gpu).

## Settings › Admin › Models

### Defaults

**Default model for everyone** and **Small model**, as above. Both choose from the visible models only.

### Available models

One block per provider, even one that lists no models (so you can add one by id). Each block shows "*N* enabled · *M*
available" and has:

- **Enabled** lists the visible ones. **Browse catalog** lists everything the provider reported, hidden ones included;
  turning on **Visible** adds a model to the Enabled list.
- A search box and 20 models per page.
- **Add model by id**: for a model the provider does not report (a router's `glm-5.3-flash-free`, say). Enter the id the
  provider uses, without spaces; an id already in the list is refused. Its ⋯ menu has **Remove**; models the provider
  reports can only be hidden.

<!-- screenshot: Settings › Admin › Models with an OpenRouter block on Browse catalog -->

Each model is one row:

| Column | What it does |
|---|---|
| Name | Editable in place; **Enter** or leaving the field saves. Empty restores the detected name. |
| **Context** | The context window in tokens (for example `32K`, `200K`, `1M`). Under it, **Calculated** or **Not calculated** appears for a provider with a memory budget (see [Context length](#context-length)). |
| **Capabilities** | **Tools**, **Prompted tools**, **No tools**; **Vision**; **Reasoning**; **Free**. |
| Star | Favorite: sorts first in the picker. |
| **Visible** | Whether the model appears in the picker. Hiding deletes nothing. |
| ⋯ | **Edit overrides…**, **Probe tool calling**, and **Remove** for models you added by id. |

### Aliases

Agent definitions written for Claude Code say `model: opus`, `sonnet`, `haiku` or `fable`. **Aliases** lets you choose which
of your models each name means. When a sub-agent's definition names an alias, it runs on that model; an alias that is
**Not set**, or a definition without a model, uses the model of the session that started it. A definition can also name a
full `provider/model` ref directly. Aliases only matter for agent definition files (a `model:` line in an `agents` folder
under `.atelier`, or under `.claude` while Claude Code compatibility is on, which it is by default); see
[Customize](/customize/) and [Claude Code compatibility](/claude-code-compatibility/).

### Calculate all

**Calculate all** at the top of the list re-checks every enabled provider: it asks each server for its models again,
recomputes the context windows from the current memory budgets, and keeps your manual overrides. It ends with "Recalculated
all models", or, when a provider could not be reached, "Recalculated with cached metadata for unavailable providers".
Use it after pulling a new model, changing a memory budget, or restarting a model server.

## Edit overrides

⋯ › **Edit overrides…** opens a dialog for the model. Empty fields keep the detected value, which shows as the placeholder.

| Field | Values | Notes |
|---|---|---|
| **Context length** | A whole number of tokens | See [Context length](#context-length). |
| **Max output** | A whole number of tokens | The most one reply may use. |
| **Temperature** | 0 to 2 | Empty uses the provider's default. See [Temperature](#temperature). |
| **Tool calling** | Automatic, Native, Prompted, None | See [Tool calling](#tool-calling-native-prompted-none). |
| **Vision** | Automatic, Supported, Not supported | Whether images are sent to the model. |
| **Prompt tier** | Automatic, Full, Compact | See [Prompt tiers](#prompt-tiers). |

Saving writes each changed field to the settings file under `models.overrides["provider/model"]`; clearing a field removes
it. A model's name, **Visible** and star are overrides too (`displayName`, `hidden`, `favorite`), and the file also accepts
`order` (a number; models sort by it after favorites, default 1000), which the page does not offer.

An override wins over what the provider reports and over Atelier's built-in knowledge. There is no override for the kind
of reasoning a model has or for PDF support. Prices are set in **Settings › Usage › Prices** (see [Cost](/providers/#cost)).

## How Atelier learns what a model can do

For each field, the first of these that has an answer wins: your **override**, then what the server **reports**, then Atelier's
built-in **catalog** (for Anthropic and OpenAI ids, which do not describe themselves fully), then a **default**.

| Provider | Context window | Max output | Tools | Vision and PDFs | Reasoning |
|---|---|---|---|---|---|
| Ollama | The model's own `context_length`, at most 32,768, unless a memory budget calculates one | The smaller of the context and 32,768 | Native if the model lists `tools`; prompted if it lists capabilities without it; native assumed if the server lists none | `vision` capability | `thinking` capability: levels if Ollama lists them (gpt-oss: low, medium, high), otherwise an on/off switch |
| llama.cpp | The server's running `n_ctx` from `/props`; else the model's training context; else 32,768 | The smaller of the context and 32,768 | Native if the chat template supports tools; prompted if it does not; native assumed if the server does not say | `/props` modalities | A switch if the template reads `enable_thinking`; levels if it reads `reasoning_effort` |
| OpenAI-compatible | The server's metadata fields, else 32,768 | The metadata's maximum, else the smaller of the context and 8,192 | Native if the metadata lists `tools` or says nothing; prompted if it lists parameters without `tools`; **No tools** on OpenRouter | The metadata's image and file input; off if there is no metadata | Levels (low, medium, high) if the metadata lists `reasoning` |
| Anthropic | `/v1/models` `max_input_tokens`, else the catalog, else 200,000 | `/v1/models` `max_tokens`, else the catalog, else 32,000 | Native | `/v1/models` capabilities, else the catalog | Effort levels, or thinking budgets on 4.5 and older |
| OpenAI | The catalog by id (for example 1,050,000 for GPT-6 and GPT-5.5, 400,000 for GPT-5.2), else 128,000 | The catalog, else 16,384 | Native | The catalog | The catalog's levels, none for GPT-4.x and GPT-4o |
| ChatGPT Plan | Your account's `context_window`, else the catalog, else 272,000 | The catalog's, else 128,000 | Native | Yes for images; PDFs where the catalog says so | The catalog's levels, else the ones your account lists |
| GitHub Copilot | The model's window, capped by its prompt limit plus output | The model's output limit, else 16,384 | Native | The model's `vision` | The model's reported levels |
| ChatGPT Chat | 128,000, fixed | 32,768 | Prompted | Yes | ChatGPT's own stops |
| A model added by id, or one not yet discovered | 200,000 for Anthropic and OpenAI, else 32,768 | 32,000 for those, else 8,192 | Native | Vision for those two only | Effort for those two only |

The catalog also supplies display names for known ids. A server that is offline when Atelier starts still has its models
listed, from the last successful listing.

## Context length

The context length is the number of tokens Atelier believes the model can hold. It decides:

- when **auto-compaction** happens (by default at 85% of the window, sooner if the reply would not fit), and how much room is
  kept free for the reply (at most a quarter of the window and 20,000 tokens);
- the context ring in Code, whose popover (**Context window**) reads, for example, `25k / 32k (78%)`;
- for **Ollama**, the `num_ctx` Atelier sends with every request, which is how a bigger window is actually requested.

For llama.cpp, LM Studio, vLLM and other servers Atelier only **reads** the window; it cannot change it. If you set a bigger
number than the server loaded the model with, requests that fill it can be refused or cut off by the server. When the server
says a request is too long, Atelier fits the conversation tighter and sends it once more; if that is refused too, the turn
ends with "The conversation is too long for this model". Raise the window where the model is loaded, then use **Test
connection** (or **Calculate all**) so Atelier reads it again.

Code warns under the message box when a model's window is under 16,000 tokens: "This model's 8k window is small for Code: long
tasks compact often. Raise it in Settings › Admin › Models." A turn that was summarized 8 times and still does not fit stops
with a message that says to raise the context length.

A reply is limited by **Max output**, by the effort (up to 32,000 tokens through Medium, 64,000 at High, the model's own
maximum at Extra and above) and by what is left in the window.

For the automatic sizing of Ollama windows from a memory budget, see [Local models](/local-models/#context-size-from-your-vram).

:::note
If you set an override on a calculated window, the override is what Atelier sends; hover **Calculated** to see "Effective
request context".
:::

## Tool calling: native, prompted, none

Atelier's tools (reading and editing files, running commands, searching, connectors) reach a model one of three ways:

- **Native**: the provider's own tool-calling interface, used by hosted models and by local models whose server reports tool
  support.
- **Prompted** (**Prompted tools** badge): for a model whose server or chat template has no tool support. Atelier describes
  the tools in the system prompt and the model writes each call as `<tool_call>{"name": …, "arguments": {…}}</tool_call>`.
  Atelier hides those blocks from the reply, repairs small JSON mistakes, checks the arguments against the tool's schema, and
  sends a call it cannot understand back to the model as an error. A model makes at most one call per message in this mode,
  and tool results come back as `<tool_result>` blocks.
- **None** (**No tools**): the model gets no tools and only talks.

Prompted tools are less reliable than native ones.

Atelier switches a model to prompted by itself when Ollama or llama.cpp report no tool support, when the server's metadata
leaves tools out, or when an Ollama model's tool schemas fail with "failed to parse grammar" or "failed to initialize
samplers" (remembered for that model until the app restarts).

### Probe tool calling

⋯ › **Probe tool calling** sends the model one request with a small `get_weather` tool and asks it to use it (a 60 second
limit). A native tool call records **Native**; anything else ("No native tool call; switched to prompted tool calling.", or
the error the server gave) records **Prompted**. The result is saved as the model's **Tool calling** override. A probe that
fails because the server is down also records **Prompted**; open **Edit overrides…** and set **Tool calling** back to
**Automatic**.

Use it when a server does not say whether a model supports tools (LM Studio, vLLM), or when a model answers with the call
written out as text instead of making it.

## Prompt tiers

Atelier writes its instructions to the model in two sizes:

- **Full** for strong models: full sentences that give the reason for a rule, and every built-in tool.
- **Compact** for small and local models: at most twelve short numbered rules, one example call per core tool, and a budget
  of **16,000 characters** for the system prompt and tool list together, because local servers often run with a 4k to 8k
  window. Over the budget, Atelier trims the skill list, then connector tool descriptions, then long instruction files. Eight
  tools are not offered at all (TaskStop, ChangeDirectory, SendMessage, ListSessions, MemoryView, ChatRead, Time, Usage).

The tier is chosen automatically: Anthropic and OpenAI models, ChatGPT Plan, GitHub Copilot and ChatGPT Chat are **Full**.
Anything else is **Full** only when its id matches a known strong family, and **Compact** otherwise:
`deepseek-` v3, v4, r1, r2, chat or reasoner; `kimi-k2`; `qwen3` 235b, 480b, max or plus (and the coder variants);
`glm-4.5` and later (not Air); `gpt-oss-120b`; `gemini-…-pro`; `grok-3` and later; `mistral-large`; `claude-…`. Routed ids such
as `vendor/model` are matched by the part after the last slash. So `gpt-oss-20b` and mid-size Qwen3 models get **Compact**.

Override it per model under **Prompt tier**: **Compact** for a model that struggles with the full prompt, **Full** for a capable
local model that was given the compact one. The prompts are published verbatim in [Prompts](/prompts/).

## Vision and PDFs

- A model without vision is told "[An image was attached, but this model cannot view images.]" instead of receiving the image.
  If a model can see but Atelier thinks it cannot (common with LM Studio and other servers that report nothing), set **Vision**
  to **Supported**.
- Images are shrunk to what each provider takes (for example 4,096 pixels and 25 MB for Ollama and llama.cpp, 8,000 pixels
  and 5 MB for Anthropic), and the oldest are left out beyond a provider's image count, with a note to the model.
- **PDFs** go to the model as files when it supports them (for example Anthropic and OpenAI models, and ChatGPT Chat). For
  any other model Atelier extracts the text and puts it in the message, and a file type it cannot read becomes "[Attached
  file *name* (*type*) cannot be read by this model.]"

## Reasoning and effort

Models that reason (the **Reasoning** badge) report how: a set of levels, a thinking budget, or only an on/off switch. What
that means for the effort control:

- Every model offers Low to Max. Where the model's own setting has the level, Atelier uses it; where it does not, the model is
  asked in a short note ("Max: apply the most rigor you can, verify everything").
- A model that can only switch thinking on or off gets a **Thinking** switch in the effort popover, on by default. It
  disappears from Extra upwards, where thinking is always on.
- A model's **Recommended** level starts the control. Claude models have their own; every other model starts at Medium, except
  ChatGPT Chat models, which start at Medium in Chat and at High in Cowork and Code.
- Ultracode is offered in Code, for every model except ChatGPT Chat, while the admin allows it. ChatGPT Chat replaces the
  scale with ChatGPT's own stops.

The warnings at Max and Ultracode are on [Effort](/effort/).

## Temperature

A **Temperature** override applies only where the provider lets Atelier set it. Ollama, llama.cpp and OpenAI-compatible
servers take it. Anthropic accepts it only on models 4.6 and older and only with thinking off. OpenAI accepts it only for known
models that do not reason. ChatGPT Plan's backend sets sampling itself, so it is dropped, and so is **Max output**. ChatGPT Chat
has no such control. Leave it empty unless you have a reason.

## When to override

| Symptom | What to try |
|---|---|
| A local model answers with the tool call written out as text | **Probe tool calling**, or set **Tool calling** to **Prompted**. |
| A vision model "cannot view images" | **Vision: Supported**. |
| Long tasks compact constantly, or "The conversation is too long for this model" | Raise the window where the model is loaded and set **Context length** to match; or lower it if you set it too high. |
| A small model ignores instructions or loops | **Prompt tier: Compact**; check its context length first. |
| Replies stop mid-sentence | Raise **Max output** (and see whether the server caps it). |
| A model Atelier does not list | **Add model by id**. |

## Where it is stored

Overrides, defaults and aliases live in the settings file's `models` section (`defaults`, `aliases`, `overrides`), shared by
everyone on this installation; your own default model is part of your account's preferences. See
[Settings reference](/reference/settings/) and [Data and files](/data-and-files/).
