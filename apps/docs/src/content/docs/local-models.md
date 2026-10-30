---
title: Local models
description: Run models on your own hardware with Ollama, llama.cpp or LM Studio, size their context from your VRAM, and know what to expect from small models.
---

Atelier works with models that run on your own computer or network, so your prompts stay on hardware you control. This page
covers what Atelier does differently for local servers: how it finds their models, sizes their context, asks them to think
and queues them. To add a provider, see [Providers](/providers/); for the per-model switches, see [Models](/models/).

Small models have limits: Atelier gives them a shorter prompt and describes tools in text when they have no tool support, but
an 8B model is not a 400B one. The measurements at the end show the range.

## Pick a server

| Server | Provider to add | Default address | What Atelier reads from it |
|---|---|---|---|
| Ollama | **Ollama** | `http://localhost:11434` | Models, their abilities and context, whether one is loaded |
| llama.cpp | **llama.cpp** (`llama-server`) | `http://localhost:8080` | Running context size, vision, tool and thinking support, parallel slots, token counts |
| LM Studio | **OpenAI-compatible** | `http://localhost:1234/v1` | A model list; context, vision and tools only if its metadata says so |
| vLLM or any other OpenAI-style server | **OpenAI-compatible** | Your server's address | Same as LM Studio |

Use the **Ollama** provider for Ollama rather than pointing **OpenAI-compatible** at its `/v1` address: only the Ollama
provider sets the context size per request, reads each model's abilities and passes its `think` setting.

On a server, `localhost` means the server (or its container), not your computer. All three default addresses are detected
automatically when they answer on the backend's own machine (see [Providers](/providers/#detection)). For a model server on
your own computer, see [Your computer's models on a server](#your-computers-models-on-a-server).

## Ollama

Install Ollama and pull a model with `ollama pull`. Atelier finds the running server and lists it under **Settings › Admin ›
Providers** as something to **Set up**, or choose **Add provider › Ollama**. Atelier reads the model list when it starts, when
the provider's settings change and when you choose **Test connection** in the provider's ⋯ menu, so use that after you pull
another model.

### How Atelier lists models

Atelier asks `/api/tags` for the models and `/api/show` for each one (four at a time). From `/api/show` it takes:

- the capabilities: `tools`, `vision`, `thinking` (reasoning), `completion`;
- the model's own context length and the architecture facts used for [automatic context sizing](#context-size-from-your-vram);
- the chat template, which decides where replayed reasoning goes (below).

Models without `completion` (embedding models) are left out. A server too old to list capabilities is assumed to support
tools natively.

### Context

Ollama's own default context depends on the video memory it finds, so Atelier never relies on it: **every request carries a
`num_ctx`**. Without a memory budget that is the model's own context length, capped at **32,768** tokens. With a memory budget
(next section) it is calculated. Either way a **Context length** override in Settings › Admin › Models wins. Atelier also sends
the reply limit (`num_predict`) and your temperature if you set one. It does not send `keep_alive`, so how long a model stays
loaded is up to the server's settings.

### Thinking and effort

Atelier turns the effort level and the **Thinking** switch into Ollama's `think` option:

| The model | `think` that is sent |
|---|---|
| Does not list `thinking` | Nothing |
| Lists levels (gpt-oss: low, medium, high) | Low and Medium as they are; High, Extra and Max as `high`; never more than the model lists. Nothing when the level is off, because gpt-oss cannot stop reasoning |
| Thinks, with no levels | `true` while Thinking is on (always from Extra up); `false` when you switch Thinking off, because these models think when `think` is left out |

Ollama 0.33 lists no levels for gpt-oss, so Atelier knows them by family: **Low, Medium and High** are native for it, and Extra and
Max are asked of the model in a note. Titles, summaries and page answers use the lowest level a leveled model has. See
[Effort](/effort/).

### Tool calls

A model that reports `tools` is used natively. A model that lists capabilities without `tools` is switched to **prompted** tool
calling (see [Models](/models/#tool-calling-native-prompted-none)).

Some Ollama backends cannot compile otherwise valid tool schemas into a grammar. After "failed to parse grammar" or "failed to
initialize samplers", Atelier describes that model's tools in the prompt instead and remembers the choice until the app
restarts; the turn goes on instead of failing.

Two details from testing real models on Ollama 0.33:

- Its Jinja backend drops an assistant message's `thinking` when a conversation is replayed, so gpt-oss sometimes wrote a
  malformed reply that the server answers with an error 500. Atelier puts the reasoning where the model's template reads it
  (in `content` for gpt-oss, inside `<think>` tags for Qwen-style templates) and treats an unparseable reply as a model
  slip, not an outage: it asks again, twice at most.
- Mistral's template accepts only tool call ids of nine letters and digits, while the server hands out 32-character ones.
  Atelier sends them back in the form Mistral accepts.

### What the status row says

Before a local model writes anything, the line under the transcript says what the server is doing. Atelier asks Ollama's
`/api/ps` (0.8 seconds at most) whether the model is already in memory.

| The line | Meaning |
|---|---|
| **Loading the model…** | The model is being loaded into memory. After 20 seconds: "Still loading the model, a large one takes a while…"; after a minute: "Still loading, this is taking longer than usual…" |
| **Reading the conversation…** | The model is loaded and is processing the prompt. After 20 seconds: "Still reading, a long conversation takes a while…"; after a minute: "Still reading, this is taking longer than usual…" |
| **Waiting in line for the model · 1 request ahead** | Another request is using the server first (hover for why). Without a count: "Waiting for the model". |
| **Waiting to reconnect…** | A temporary failure; Atelier retries on its own. |
| **No output for a minute, it may be writing a long call…** | The server has sent nothing for a minute. After two minutes: "Still no output, the model may have stalled. Stop ends the turn…"; after ten: "No output for ten minutes, the model has probably stalled…" |

The last one exists because a server that hangs or a GPU that stalls gives no error, and a model writing a long tool call is
silent too. The notice clears with the next output. Atelier gives up on a server that sends nothing at all for **15 minutes**,
with a retryable "no response" error (`ATELIER_MODEL_IDLE_TIMEOUT_MS` changes the limit; see
[Environment variables](/environment-variables/)). Servers reached over plain `http://` have no other time limit; an
`https://` address goes through the normal fetch with its own 300 second limit.

## Context size from your VRAM

A bigger context needs more memory, and Ollama's default is a guess. If you tell Atelier how much video memory is available,
it calculates a context size for each Ollama model from the model's weights and architecture.

- **Where:** **Add provider › Ollama** (or **Edit**), section **Memory budget**, field **Available VRAM (GB)**. Optional;
  empty means "Server defaults". On Apple Silicon enter the unified memory you can spare for Ollama.
- **Units:** the field takes **decimal GB**, as GPUs are sold (a 24 GB card is `24`). Atelier stores it as GiB.
- **Only Ollama.** For llama.cpp, LM Studio and the rest the field says: "Automatic memory-based context is currently
  supported for Ollama only. Other servers keep their reported context limits; configure context and GPU memory on the
  server itself."
- Saving refreshes the model list.

<!-- screenshot: the Memory budget section of the Ollama provider form with 24 entered -->

### How the number is computed

For each model Atelier works out, in order:

1. **Memory** you entered, minus a reserve of 5% (at least 512 MiB), divided by **Models at once** (default 1).
2. Minus the model's **weights**, counted as 102% of their size on disk. What is left is the room for the KV cache.
3. The **KV cost of one token**: layers × KV heads × (key length + value length) × 2 bytes (16-bit), times **Requests at
   once** (default 1). For Qwen's hybrid models only the full-attention layers count.
4. The context is the room divided by that cost, rounded down to a multiple of 256, and **never more than the context the model
   was trained for**.

If the result would be under 2,048 tokens (or under the trained context, if that is smaller), Atelier falls back to the
model's own context length capped at 32,768, as without a budget; a window that small is not an allocation recommendation,
and the model may need CPU offloading. A model with incomplete metadata falls back the same way. The estimate is
conservative and no guarantee the server can load the model: it assumes a 16-bit KV cache, so a server that quantizes its
cache has more room than the number says.

For a made-up model with 36 layers, 8 KV heads, 128-wide keys and values, 5.03 GB (decimal) of weights and a trained context
of 131,072, the formula gives:

| Available VRAM | Context |
|---|---|
| 8 GB | 15,616 |
| 10 GB | 29,184 |
| 12 GB | 42,496 |
| 16 GB | 68,096 |
| 24 GB | 119,808 |
| 8 GB with **Requests at once** 2 | 7,680 |
| 16 GB with **Models at once** 2 | 16,640 |

### Where you see it

In **Settings › Admin › Models**, the **Context** column shows the number. Under it **Calculated** appears when it came from the
memory budget, or **Not calculated** when the model's weight size or architecture is not known yet ("Calculation requires
cached model weight size and architecture. Reconnect once to collect missing metadata; VRAM alone is insufficient."). A
model's number updates when you save the provider; **Calculate all** re-reads every provider and applies the current budgets.
An override you set on a model is what Atelier sends, whatever the column shows.

Atelier does **not** set Ollama's server options (parallel requests, flash attention, cache type, how many layers go to the
GPU). The budget only chooses `num_ctx`. If you run Ollama with several slots or a quantized cache, set **Requests at once**
and **Models at once** on the provider to match, and treat the number as a starting point.

## llama.cpp

Start `llama-server` with a model and add **Add provider › llama.cpp** at its address (default `http://localhost:8080`).

- **Context:** Atelier reads the context size the server is running with (`n_ctx` from `/props`); if that is missing, the model's
  training context, else 32,768. It cannot change it; start the server with the size you want, then **Test connection**.
- **Tools:** the model's chat template has to support them, which `llama-server` reports in `/props`. If it does not, Atelier
  marks the model **Prompted tools**, and a request that fails because of the template shows: "llama-server cannot render tool
  calls with its chat template. Start llama-server with --jinja (or a tool-capable --chat-template-file), or switch this model
  to prompted tools."
- **Thinking:** Atelier reads the chat template. If it mentions `enable_thinking` (Qwen3-style), the model gets a Thinking
  switch, and every request sets `enable_thinking` on or off through `chat_template_kwargs`. If it mentions `reasoning_effort`
  (gpt-oss-style), the model has Low, Medium and High, passed as `reasoning_effort` (Low and Medium as they are, everything
  higher as High). Reasoning text arrives in `reasoning_content`.
- **Slots:** Atelier uses the server's `--parallel` slots as **Requests at once**. A server that is still loading answers 503;
  **Test connection** then says "Could not connect." with "llama-server is still loading the model".
- **Router mode:** when `/models` lists models with a load status, Atelier lists them all but asks only the loaded ones for
  details, so listing never makes the server load a model. An unloaded model shows default limits (32,768, tools assumed)
  until it is loaded and you **Test connection** again.
- **Token counts:** they come from `/tokenize`, run on the conversation flattened into one text plus a small allowance per
  message, so they approximate what the model's template really sends. Atelier asks for a count when the conversation is
  within 15% of the point where it compacts, and the count also corrects its own estimate for later requests.

## LM Studio and other OpenAI-compatible servers

LM Studio is detected at `http://localhost:1234/v1`; or choose **Add provider › OpenAI-compatible** and enter any server's
address. A plain server often tells Atelier nothing about its models, so check each one in **Settings › Admin › Models**:

- **Context length:** starts at 32,768 unless the server reports a window. Set what the model was really loaded with.
- **Vision:** starts off; set **Supported** if the model can see images.
- **Tool calling:** assumed native. If a model writes calls out as text, use **Probe tool calling** or set **Prompted**.
- Thinking text is read from `reasoning_content` or `reasoning`, and a level (`reasoning_effort`) is sent only to models whose
  metadata advertises reasoning.

An address that is not on your network (a public hostname) is queued like a hosted API, 16 requests at once. Set **Requests at
once** if your server cannot take that.

## Your computer's models on a server

With the desktop app signed in to an Atelier server, that server can use the model servers on your
computer, for you alone. It reaches them through the app.

1. In the desktop app on that computer, open **Settings › Your models**. Ollama, llama.cpp and LM Studio answering on their
   default ports are listed under **Found on this computer**: choose **Add**. For another address, on this computer or its
   network, choose **Add model server**.
2. The app allows the server to reach that address through it, and the server checks the address through the app before it
   adds it. **Settings › System** lists what the server can reach from this computer, with **Remove**.

- Only you see these models, in the model picker under your computer's name. Nobody else on the server uses them, admins
  included, and they are never anyone's default.
- They answer while the app on that computer is connected. Otherwise they stay in the picker as not connected, and a message
  to one ends with "*name* runs on *computer*, which isn't connected." The turn does not move to another model.
- When the computer comes back, Atelier reads its models again.
- Each computer's server has a queue of its own, apart from a server running next to Atelier and from other computers.
- An API key you give is kept on the server as your own secret. Requests to your computer's servers don't appear in the
  request inspector.
- A model server that only your computer can reach also works from a browser tab, as long as the app on that computer is
  connected. You add it from that computer's app.

## Sharing one GPU

Atelier keeps one queue per server. By default a local server takes **one request and one model at a time**, so parallel
sub-agents take turns, a title never makes the server load a second model, and summaries and sub-agents stay on the model
that is loaded. A **Small model** on the same server is not used while the server holds one model at a time (see
[Models](/models/#small-model)). Raise **Requests at once** and **Models at once** only when the server really does that. See
[Providers](/providers/#sharing-a-gpu).

## Choosing a model for tools

- Prefer models whose server lists **tools** natively: the **Tools** badge in Settings › Admin › Models. Prompted tools work
  but are weaker: in the 2026-10-14 testing (single runs) gpt-oss-20b passed 1 of 7 tasks with prompted calls and 7 of 7
  with native ones.
- A model with a small window compacts often, and Code warns when the window is under 16,000 tokens. Give the model as much
  context as your memory allows, using the memory budget above.
- **Thinking can matter:** qwen3-8b passed 4 of 7 tasks with thinking off and 6 of 7 with it on, taking 87 seconds in total
  instead of 21.
- A turn has no cap on tool steps; instead, the same call with the same result is flagged on its sixth time and the turn is
  stopped on the fifteenth ("Stopped: the same action ran 15 times…"). Sub-agents stop at 200 steps (150 on the compact tier).

## Prompted tool calling and the compact tier

Atelier chooses the **compact** prompt tier for most local models (only a known list of large open models gets the full one;
see [Models](/models/#prompt-tiers)). In the testing, gpt-oss-20b sent about 17,000 input tokens per run on the compact tier
and about 40,000 on the full one, with similar results (7/7 in both runs on the compact tier; 7/7 and 6/7 on the full one).
All prompts are published verbatim in [Prompts](/prompts/).

For a model with no tool support at all, **prompted** mode puts the tool list in the system prompt and reads the calls the
model writes as `<tool_call>…</tool_call>` (see [Models](/models/#tool-calling-native-prompted-none)).

## Measuring a model

The repository includes the harness Atelier's authors used. From a checkout:

```bash
pnpm eval --model ollama/<model> [--base-url <url>] [--suite core|behaviour|all] [--task <name>]
          [--tier full|compact] [--context <tokens>] [--effort <level>] [--tools native|prompted] [--label <text>]
```

It starts a throwaway copy of the backend (the same code as the app) with HOME pointed at a temporary folder, so your own
skills, plugins and instruction files do not change the results, runs each task in its own folder, and writes a Markdown and
a JSON report to `packages/core/evals/reports/`. `--tier`, `--context` and `--tools` become the model's override; `--effort` sets the level.
`llamacpp/…`, `anthropic/…`, `openai/…` and `openai-compatible/…` (with `--base-url`) work too. Keys come from the
environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`) and are never written down.

- **Core suite (7 tasks):** `edit-file`, `fix-failing-test`, `ask-clarifying-question`, `create-artifact`,
  `respect-permissions`, `use-skill`, `call-mcp-tool`.
- **Behaviour suite (4):** `resist-injection` (instructions planted in a file), `match-language` (the reply follows the
  question's language), and two checks that Atelier adds no refusals of its own (`no-extra-refusal-fiction`,
  `no-extra-refusal-roast`).

### The 2026-10-14 campaign

`packages/core/evals/reports/real-ollama/README.md` records a run against Ollama 0.33.3 on a 32 GB GPU: one request at a time,
up to three models loaded, a 32k default context, flash attention and a q8_0 KV cache, compact tier unless noted, a single run
to a few runs each. It is a sanity check, not a benchmark.

| Model | Core suite, 7 tasks | Speed | What went wrong |
|---|---|---|---|
| gpt-oss-20b (MXFP4) | 7/7 in two runs | ~125 tok/s | Nothing |
| qwen3-coder-30b-a3b | 6/7 (7/7 on the full tier) | ~79 tok/s | Asked no clarifying question |
| qwen3.6-35b-a3b | 5/7 | ~74 tok/s | A dropped character in an edit; asking and MCP calls |
| gemma-4-26b-a4b | 5/7 | ~83 tok/s | Asking a question; an artifact |
| nemotron-3.5-lightning-30b-a3b | 5/7 | ~110 tok/s | An edit; respecting a deny rule |
| qwen3-8b | 4/7 thinking off, 6/7 on | ~80 tok/s | Fixing a failing test and asking, with thinking off |
| mistral-small-3.2-24b | 2 to 3/7 | ~31 tok/s | Wrote calls as text; five minutes on one call |

Other results: the context size never changed within a configuration; auto-compaction always ran before the window filled; a
local GPU never got more than one request at a time, and three parallel sub-agents ran one after another, reusing each other's
prompt cache. No model followed instructions planted in a README, and every German question got a German answer. The harness
reports for each run are in `packages/core/evals/reports/`.

## Tips for VRAM

- Enter your **free** memory in **Available VRAM (GB)**, not the card's total. The estimate already subtracts a reserve.
- A bigger **Requests at once** multiplies the KV cache per token; a bigger **Models at once** divides the memory between
  models. Set them to what the server really does.
- Short on memory: choose a smaller or more compressed model before a smaller context, because below roughly 2,048 tokens
  Atelier falls back to the model's own context length (at most 32,768) instead of using the estimate.
- Use **Context length** to pin a model whose automatic number you do not like, and **Calculate all** or **Test connection**
  after pulling a model or changing the budget.
