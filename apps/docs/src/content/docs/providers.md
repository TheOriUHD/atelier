---
title: Providers
description: Connect Ollama, llama.cpp, LM Studio, Anthropic, OpenAI, a ChatGPT plan, GitHub Copilot, OpenRouter or OpenCode Zen, and learn what each one needs, speaks and costs.
---

A provider is where models come from: a server you run, a hosted API, or a subscription you sign in to. Admins add
providers in **Settings › Admin › Providers**; on **Run on this computer** you are the admin. Everyone else sees only the
models the admin leaves visible, in the model picker (see [Models](/models/)).

![Settings › Admin › Providers, with a detected provider, a connected Ollama server and Add provider](/img/providers-2496.webp)

Atelier checks every enabled provider when it starts and whenever you add, edit, enable or disable one, and again on
**Test connection** in a provider's ⋯ menu or **Calculate all** on the Models page. After you pull a new model on a local
server, use one of those to see it.

## Add a provider

1. Open **Settings › Admin › Providers**. Anything Atelier found on this machine is listed under **Detected on this
   machine** with a **Set up** button (see [Detection](#detection)).
2. Choose **Add provider** and pick one of the choices below.
3. Fill in the details, or follow the sign-in step for the subscription providers.
4. Optionally choose **Test connection**, then **Add provider**. Saving checks the connection again and lists the models.

<!-- screenshot: the Add provider dialog listing all the choices -->

| Provider | About |
|---|---|
| **Ollama** | Models that run on your own machine through Ollama. Free to use; Atelier sizes each model's context window from your GPU memory. |
| **llama.cpp** | A `llama-server` you run yourself, for GGUF models. |
| **OpenAI-compatible** | Any server that speaks the chat completions API: LM Studio, vLLM, and so on. |
| **Anthropic** | Anthropic's models through their API. Needs an API key; priced per token. |
| **OpenAI** | OpenAI's GPT models through their API. Needs an API key; priced per token. |
| **ChatGPT Plan** | The models in your ChatGPT plan. Sign in with your account; no per-token cost. Unofficial. |
| **GitHub Copilot** | The models in your Copilot plan. Sign in with a code from GitHub. Unofficial. |
| **ChatGPT Chat** | Experimental. ChatGPT itself, driven through a signed-in browser window. Desktop app only. |
| **OpenRouter** | Hundreds of hosted models, some of them free, through one OpenRouter account. Connect in one click. |
| **OpenCode Zen** | Hosted models through an OpenCode Console key. |

OpenRouter and OpenCode Zen are not types of their own: they are OpenAI-compatible providers at a fixed address that Atelier
sets up for you.

## Which provider speaks which API

| Provider | API Atelier uses | Key | Runs | Desktop only | Tool calling | Effort | Images | Notes |
|---|---|---|---|---|---|---|---|---|
| Ollama | Ollama's native API (`/api/chat`) | Optional | Local | No | Native if the model reports `tools`, else prompted | The model's `think`: levels, or on/off | If the model reports `vision` | Context set on every request; memory budget sizes it |
| llama.cpp | `llama-server`: chat completions plus `/props`, `/health`, `/tokenize` | Optional | Local | No | Native if the chat template supports tools, else prompted | The template's `enable_thinking` or `reasoning_effort` | If `/props` lists vision | Needs a tool-capable chat template; reports its slots |
| OpenAI-compatible | Chat completions (`/v1/chat/completions`) | Optional | Either | No | Native, or prompted if the server's metadata lacks tools | `reasoning_effort` (low, medium, high) where the model advertises reasoning | If the server's metadata lists image input | Starts at 32,768 context and no vision unless the server says more |
| Anthropic | Messages | Required | Hosted | No | Native | Adaptive effort (Low to Max), or thinking budgets on 4.5 and older | Yes, and PDFs | List prices built in |
| OpenAI | Responses | Required | Hosted | No | Native | Per model: Low to Extra, Low to High, or none | Yes, for the models Atelier knows | List prices built in; a catalog supplies each model's limits |
| ChatGPT Plan | Responses, on ChatGPT's Codex backend | Sign-in | Hosted | No (browser on the desktop, device code on a server) | Native | The levels your account lists | Yes | Unofficial; uses your plan, no per-token price |
| ChatGPT Chat | None: drives a signed-in chatgpt.com page in a hidden window | Sign-in | Hosted | Yes | Prompted, always | ChatGPT's own stops (Instant, Medium, High and, on higher plans, Extra High and Pro) | Images and PDFs | Experimental and fragile; one conversation slot |
| GitHub Copilot | Chat completions, or Responses for models that only take it | Sign-in | Hosted | No (device code) | Native; models without tool calls are left out | The levels each model reports; **Copilot Auto** uses three tiers | If the model reports vision | Unofficial; uses your Copilot plan |
| OpenRouter | Chat completions | Required, or Connect | Hosted | No | Native; **No tools** for models OpenRouter lists without tools | Where the model advertises reasoning | From OpenRouter's metadata | **Free** models with a daily limit; models hidden until you choose |
| OpenCode Zen | Chat completions | Required | Hosted | No | As OpenAI-compatible | As OpenAI-compatible | As OpenAI-compatible | Its free models may only work inside OpenCode |

"Optional" keys are sent as a bearer token only when you enter one. Every model also gets the Low to Max effort scale; where
the provider's own setting cannot express a level, Atelier asks the model for it in a short note (see [Effort](/effort/)).
The exceptions are ChatGPT Chat, whose stops replace the scale, and Ultracode, which only Code offers.

## Ollama

- **Base URL:** `http://localhost:11434` by default. A trailing `/v1` that you paste is dropped.
- **Key:** optional.
- **What Atelier asks:** `/api/version` for health, `/api/tags` and `/api/show` for the model list and what each model can
  do, `/api/chat` for replies, and `/api/ps` to tell "loading the model" from "reading the conversation".
- **Memory budget:** a field for the GB of video memory available, which sizes each model's context automatically. See
  [Local models](/local-models/#context-size-from-your-vram).

Everything specific to Ollama (the `think` setting, loading messages, the grammar fallback) is on
[Local models](/local-models/).

## llama.cpp

- **Base URL:** `http://localhost:8080` by default.
- **Key:** optional.
- **What Atelier asks:** `/health`, `/props` (context size, vision, chat template), `/v1/models`, `/v1/chat/completions`
  and `/tokenize` for token counts. In router mode (when `/models` lists models with a load status) it lists every
  model and reads details only for the ones that are loaded, so asking never makes the server load one.
- **Tools:** the model's chat template has to support tools. When `/props` reports a template without tool support, Atelier
  uses prompted tools for that model. When the server only fails once a request carries tools, you get the message under
  [Provider errors](#provider-errors), and you can switch the model to prompted tools.

## OpenAI-compatible

Use this for LM Studio, vLLM, a gateway, or any server that offers `/v1/chat/completions` and `/v1/models`. A llama.cpp
`llama-server` also offers them, but the **llama.cpp** provider reads more from it; use that one.

- **Base URL:** `http://localhost:1234/v1` by default (LM Studio's port). Give the address of your server, with or without
  `/v1`; Atelier never doubles the version segment.
- **Key:** optional; sent as `Authorization: Bearer …`.
- **Models:** from `/v1/models`. Ids that look like embedding, speech (`whisper`, `tts`), transcription, DALL-E, moderation
  or reranking models are left out.
- **What Atelier reads from the model list** when the server provides it: `context_length`, `max_model_len`,
  `context_window`, `max_context_length` or `top_provider.context_length`; image input; the supported parameters (`tools`,
  `reasoning`). A plain server such as LM Studio usually reports none of these, so a model starts at a **32,768** token
  context, with tools assumed native and **vision off**.
- **What to do about that:** open **Settings › Admin › Models**, then ⋯ › **Edit overrides…** to set the real context
  length and mark vision as supported, or use **Probe tool calling** to check tools. See [Models](/models/).
- **Detection:** only LM Studio's default, `http://localhost:1234/v1`, is detected, as "LM Studio".
- **Queue:** an address on this computer or your local network counts as one GPU (one request at a time); a public
  address counts as a hosted API (16 requests at once). Set **Requests at once** if that is wrong for your server.

## Anthropic

- **Base URL:** `https://api.anthropic.com`. **Key:** required (sent as `x-api-key`, with `anthropic-version: 2023-06-01`).
- **Models:** `/v1/models` reports each model's context window, output limit, image and PDF input and effort levels; Atelier
  uses those, and a built-in catalog for ids that report nothing. A model that is in neither gets 200,000 tokens of
  context and 32,000 of output.
- **Thinking:** current models use adaptive thinking with the chosen effort level (clamped to the levels the model lists).
  Models up to 4.5 use a thinking budget instead: 4,000, 10,000, 20,000, 32,000 and 48,000 tokens from Low to Max, never more
  than the reply's output limit allows.
- **Sampling:** a temperature you set is sent only when thinking is off and the model accepts it (4.6 and older). Newer
  models reject it, so Atelier never sends it.
- **Caching:** prompts are cached (up to four cache breakpoints), and cache reads and writes are priced separately.
- **Cost:** see [Cost](#cost).

## OpenAI

- **Base URL:** `https://api.openai.com`. **Key:** required.
- **API:** the Responses API, stateless (`store: false`); reasoning items come back encrypted and are replayed with the calls
  they preceded.
- **Models:** `/v1/models` has no capability data, so Atelier keeps a catalog by id (context window, output limit, vision,
  PDFs, effort levels) and lists only chat models (`gpt-…`, `o3`-style and `chatgpt-…` ids, without audio, realtime,
  transcription, speech, image, search, embedding, instruct, moderation and computer-use variants). A model missing from the catalog gets a
  **128,000** token context, **16,384** tokens of output, no vision and no reasoning control; fix it with an override.
- **Sampling:** a temperature is sent only for known models without reasoning, which reject it.
- **Cost:** see [Cost](#cost).

## ChatGPT Plan

The models in your ChatGPT plan, signed in the way OpenAI's Codex signs in, so usage counts against your plan instead of
per-token billing. It is not **ChatGPT Chat**; [ChatGPT](/chatgpt/) compares the two and assesses the risks.

- **Desktop app:** **Add provider › ChatGPT Plan › Sign in with ChatGPT** opens your browser; Atelier receives the sign-in on
  `localhost:1455` and the provider is added when it finishes. The browser sign-in times out after 5 minutes.
- **Server:** the same button shows a one-time code and a link to OpenAI's verification page. Enter the code within 15
  minutes. Everyone who can use the provider uses the admin's plan.

:::caution
This is unofficial. OpenAI documents the sign-in for its own tools, not as an API, so it can change or stop working.
:::

## ChatGPT Chat

An experimental second way to use a ChatGPT plan: Atelier drives the chatgpt.com page in a browser window you sign in to
once. It exists only in the desktop app, is fragile by nature, and may conflict with OpenAI's terms. Read
[ChatGPT](/chatgpt/) before you add it.

## Your own models on a server

*(next release)* On a server, everyone can add the model servers on their own computer and their own ChatGPT Chat in
**Settings › Your models**, from the desktop app on that computer. They are not providers for everyone: only that person
sees and uses them, while the app there is connected. See
[Local models](/local-models/#your-computers-models-on-a-server).

## GitHub Copilot

Signs in with your GitHub account instead of a key, and lists the models in your Copilot plan.

1. **Add provider › GitHub Copilot › Sign in with GitHub** shows a short code.
2. Open github.com/login/device (the dialog links it), enter the code and approve.
3. The provider is added and the models appear in the picker.

It works in the desktop app and on a server, because the sign-in needs no redirect back to Atelier. On a server everyone
who can use the provider uses the admin's plan, so add it only where that is allowed. It needs an active Copilot
subscription on that GitHub account.

- **Which models:** the ones your plan's model picker offers that take tool calls and are not disabled by your plan's
  policy. Models only reachable through Anthropic's message format are left out. Context is the model's window, capped by
  its prompt limit.
- **Copilot Auto:** a model named **Copilot Auto** asks Copilot's router to choose the model for each conversation. On
  plans whose model picker holds only Auto (Free and Student) it is listed first, followed by the models their policy
  enables; on other plans it is listed last. Low, Medium and High effort are the router's Efficiency, Balance and
  Intelligence tiers, and Extra and Max also ask for Intelligence. If the router cannot be reached, the plan's fallback
  model answers, and the router is tried again after five minutes. Auto has not been verified against a Free or Student
  account.
- **Your messages and the agent's:** your own messages count as yours with Copilot; tool steps, sub-agents and titles count
  as the agent's.
- **Limits:** Copilot's own allowance applies. Atelier cannot show how much is left; the context popover in Code shows your
  token use instead.

:::caution
Unofficial. GitHub documents Copilot's API for its own editors, so it can change or stop working. To be accepted, Atelier
sends the editor identification headers Copilot's own plugin sends.
:::

## OpenRouter

**Add provider › OpenRouter** gives you two ways to supply a key:

- **Connect with OpenRouter** opens OpenRouter in your browser. Sign in and allow Atelier; OpenRouter creates a key, and
  Atelier stores it encrypted and adds the provider. Nothing is pasted. The wait ends after ten minutes.
- Or paste a key from openrouter.ai/keys into the **API key** field.

In the desktop app the browser comes back to the app on your computer. If you decline access, the form says "OpenRouter
didn’t connect: access was declined." On a server the browser comes back to the server's own address, so finish in the same
browser you started in, signed in to Atelier as yourself. Declining there shows the message in the browser page, and the
form keeps waiting until you close the dialog or the ten minutes pass ("Connecting timed out. Start it again."). If
OpenRouter refuses the connection, the form shows "OpenRouter refused the connection (status…)."

- **Base URL:** `https://openrouter.ai/api/v1`.
- **Free models:** models whose id ends in `:free`, or that OpenRouter prices at zero, are marked **Free** on the Models page
  and "free" in the picker. They cost nothing but are limited to 50 requests a day (1,000 once you have bought at least 10
  credits).
- **No tools:** models OpenRouter lists without tool calling are marked **No tools**, because OpenRouter routes a request with
  tools only to endpoints that take them.
- **Hidden by default**: OpenRouter lists hundreds of models, so none appear in the picker until you choose. Open
  **Settings › Admin › Models**, switch to **Browse catalog** under OpenRouter, and turn on **Visible** for the ones you
  want. A model you favorite, add by id, or use as a default or an alias is shown without that.
- **Attribution:** requests carry OpenRouter's app headers (`HTTP-Referer: https://atelierhq.dev`, `X-Title: Atelier`), so the
  traffic shows as Atelier in your OpenRouter activity.

## OpenCode Zen

**Add provider › OpenCode Zen** takes a key from the OpenCode Console (opencode.ai), where billing may be required. Its free
models may only work inside OpenCode itself.

- **Chat address:** `https://opencode.ai/inference/openai/v1`. The model list is read from `https://opencode.ai/inference/v1/models`.
- Models are listed and shown like any other OpenAI-compatible provider; nothing is hidden by default.

## The form

Providers with a form (everything except the three sign-in providers) share these fields.

| Field | What it does |
|---|---|
| **Name** | What you see in lists and the picker. Renaming also renames the ID until you edit the ID yourself. |
| **ID** | Lowercase letters, digits and dashes, starting with a letter or digit, at most 48. Models are referenced as `id/model-name` in defaults, aliases, prices and sessions, so it cannot be changed after the provider exists. A second provider with a taken ID gets `-2`, `-3`… |
| **Base URL** | Must start with `http://` or `https://`. The backend makes the request, so `localhost` means the computer (or container) the backend runs on, not your browser's. |
| **API key** | Required for Anthropic, OpenAI, OpenRouter and OpenCode Zen; optional for the rest. See [API keys and secrets](#api-keys-and-secrets). |
| **Custom headers** | Extra request headers, one name and value per row. Names cannot be empty, contain spaces, or repeat. |
| **Memory budget** | Local servers only: **Available VRAM (GB)**. Used for Ollama only; see [Local models](/local-models/). |
| **Requests at once** | 1 to 64, or empty for automatic. How many requests Atelier sends the server at the same time. |
| **Models at once** | 1 to 16, or empty for automatic. How many different models the server keeps loaded at once. |

The two limits are what the server's GPU can take: Atelier queues the rest. Automatic means what the server reports (llama.cpp
reports its slots), else one of each for a server on this computer or your network, else 16 requests and no model limit for a
hosted API. Details are in [Sharing a GPU](#sharing-a-gpu).

Custom header values are stored in the settings file as you type them. To keep a token out of it, add the token under
**Settings › Admin › Keys & secrets** and enter `${secret:its-id}` as the header value.

## API keys and secrets

When you save a provider with a key, Atelier stores the key in its secret store and keeps only a reference
(`${secret:provider-<id>}`) in the provider's settings.

- **Encrypted at rest.** On the desktop the secret store is encrypted with the operating system's secure storage; on a server
  it uses AES-256-GCM with `ATELIER_SECRET_KEY` or a key file readable only by the server. See [Security](/security/) and
  [Self-hosting](/self-hosting/).
- **Never shown again.** Only the last characters appear ("Key ••••3f9a" on the provider row). **Replace** lets you type a
  new key; leaving the field alone keeps the stored one.
- **Detected keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` in the backend's environment) appear as "From $NAME". Saving copies the
  value into the secret store; it does not stay linked to the environment. **Enter a key** swaps to typing one.
- **Keys & secrets:** **Settings › Admin › Keys & secrets** lists every stored secret with its masked value, what uses it
  (for example "Provider Anthropic"), and when it was created, last used and rotated. **Rotate** replaces the value everywhere it
  is used, from the next connection on. **Delete** is refused while something uses the secret ("Used by Provider X. Remove that
  first."). **Add secret** stores a key or token you can reference as `${secret:id}` in header values and connector settings.
- **Removing a provider** deletes its stored key but not the key at the provider's side; revoke it there if it should stop
  working.

## Test connection

**Test connection** in the dialog (and in a provider's ⋯ menu) asks the server for its health and its model list. It does not
send a message. It gives up on the health check after 6 seconds and on listing models after 15.

On success the dialog reads "Connected · 12 models · 34 ms", with any warnings under it. On failure it shows the reason:

| Message | Meaning |
|---|---|
| "Nothing is listening at *host:port*." | The connection was refused: the server is not running, or the port is wrong. |
| "No answer from *host:port* within 6 seconds. Check that the server is running and that this computer can reach it (firewall, address, port)." | Nothing answered in time. |
| "*Name* rejected the credentials (401): …" | The key is wrong or revoked. The text after the colon is the provider's own. |
| "*Name* endpoint not found (404) — check the base URL" | The address is not the API's root. |
| "Cannot reach *Name* at *host*" | The request failed before any answer: DNS, TLS or another network error. |
| "Enter the key again to test it. Saving re-checks the connection with the stored key." | You are editing a provider that needs a key and did not retype it. Save instead, or test from the ⋯ menu. |
| "Could not connect." with "llama-server is still loading the model" | llama-server answered 503 while it loads. Try again in a moment. |

The form also validates before testing, with a message under the field: a missing name or key ("*Name* needs an API key."),
an ID that is malformed or already taken, a URL that doesn't start with `http://` or `https://`, an empty or repeated
header name, a limit outside 1 to 64 (1 to 16 for **Models at once**), or a memory budget that isn't a number above 0.

## Detection

**Detected on this machine** lists what Atelier finds where the backend runs, each with **Set up**, which opens the form
prefilled. **Scan again** repeats it. It looks for:

| Found | How |
|---|---|
| Ollama | `localhost:11434/api/version` answers with a version. |
| llama.cpp | `localhost:8080/health` answers `ok`, or 503 with an error while loading. |
| LM Studio | `localhost:1234/v1/models` answers with a model list. |
| Anthropic | `ANTHROPIC_API_KEY` is set in the backend's environment and no Anthropic provider exists. |
| OpenAI | `OPENAI_API_KEY` is set and no OpenAI provider exists. |

Each probe waits 800 ms. Only each server's own response shape is accepted, since other apps use these ports too. A server you
already added at its default address is not listed again. When nothing is found, the section says "Nothing new found."
On a server, "this machine" is the server, not the computer in front of you.

## Manage providers

Each provider is a row with its name and type, its address (or the signed-in account for the subscription providers),
latency, number of models, for local servers its request limit, and the key's last characters.

- **Status dot:** Connected, Connected with warnings, Unreachable (with the error under the name), Not checked yet, or
  Disabled. Warnings show under the name.
- **Switch:** turns the provider on or off. Switching re-checks it. A disabled provider keeps its settings and key; its models
  leave the picker and Settings › Admin › Models, and a conversation that still uses one says "*Name* is disabled."
- **⋯ menu:** **Test connection**, **Edit** (not for the sign-in providers), **Remove**. ChatGPT Chat's menu also has **Open
  ChatGPT session** and **Temporary chats**.
- **Remove** asks first. The provider's models leave the picker and its stored API key is deleted; chats that used it stay
  in your history. For ChatGPT Plan and GitHub Copilot it signs you out and deletes the stored sign-in; for ChatGPT Chat it
  clears the private browser session. Overrides, defaults and aliases that name the provider's models stay in settings; a
  default that points at a removed model shows as "no longer available".

If a provider is unreachable, its models stay in the picker from the last successful listing, and a conversation using one fails
with a "Cannot reach…" message until the server is back.

## Sharing a GPU

Atelier keeps one request queue per model server, and providers at the same address share it. A local server takes one request
and one model at a time unless you or the server say otherwise; a hosted API takes 16 requests and any number of models. An
address counts as local when it is a loopback, link-local or private-network IP address (10.x.x.x, 172.16 to 31.x.x, 192.168.x.x,
100.64.x.x to 100.127.x.x), a bare name without dots (`my-gpu-box`), or a name ending in `.local`, `.lan`, `.home`, `.internal`,
`.home.arpa`, `.localhost` or `.ts.net`.

- Short requests you are waiting on (a session's title, an Auto mode check) go first, then your own replies, then sub-agents,
  then other background work. Parallel sub-agents take turns.
- Titles, summaries and sub-agents stay on the model that is loaded: a small model on the same server is not used while that
  server holds only one model, because that would swap models.
- While a request waits, the status row says "Waiting in line for the model · 1 request ahead" (or "Waiting for the model").
- ChatGPT Chat always has exactly one request at a time.

## Cost

- **Anthropic and OpenAI** models use the providers' published **list prices**, built in (including cache reads and writes, and
  the long-prompt tier where one applies). Prices were taken from the providers' pages on 2026-10-15 and are updated by hand; a
  model that is not in the table shows no cost rather than a guess.
- **Your own prices** win. As an admin, open **Settings › Usage**, **Prices › Add price**: choose a model and enter dollars per
  million tokens for input, output, and optionally cache read and cache write ("As input" when empty). A price counts for requests
  made after you set it. This is the way to price OpenAI-compatible, OpenRouter, Copilot and local models.
- **No price, no cost:** every other provider, including ChatGPT Plan, counts tokens only. A subscription's
  allowance is the limit, not a price.
- Where you see it: **Settings › Usage**, and in Code the context popover shows the session's cost for Anthropic, OpenAI and
  OpenAI-compatible models that have a price, or the plan's usage windows for ChatGPT Plan.

## What is tested live

The project tests against real servers for only some providers:

| Provider | How it is tested |
|---|---|
| Ollama | Live: a campaign of the eval suite on a real GPU with seven models (see [Local models](/local-models/#measuring-a-model)). |
| Anthropic | Live API. |
| llama.cpp | Recorded responses only. |
| OpenAI | Recorded responses only. |
| OpenAI-compatible, OpenRouter, OpenCode Zen, GitHub Copilot, ChatGPT Plan | Unit tests against recorded or hand-made responses; the optional live checks in the repository can target an OpenAI-compatible endpoint, but they are not part of the regular runs. Copilot Auto has not been tried on a Free or Student account. |
| ChatGPT Chat | Driven against the real chatgpt.com page for formatting, continuing a chat, temporary chats, model and effort selection, and tool calls. A long Code session on it has not been run end to end. |

ChatGPT's and Copilot's sign-ins are not documented by their owners as APIs. Treat both as able to break without notice.

## Provider errors

Messages a conversation shows when a provider fails. *Name* is the provider's name.

| Message | Meaning and what to do |
|---|---|
| "*Name* rejected the credentials (401)…" | Key revoked or wrong. Replace it in **Settings › Admin › Providers › Edit**. |
| "Model not found: …" | The provider does not know that model id. Check **Settings › Admin › Models**. |
| "*Name* is busy or unavailable (503)…" | Overloaded or rate limited. Atelier retries on its own. |
| "*Name* usage limit reached: …" | A billing, quota or plan limit ("insufficient quota", "usage limit reached", "weekly limit"). The turn ends at once instead of retrying. Rate limits that clear by themselves still retry. |
| "The conversation is too long for this model: …" | The provider refused the request as over its window. Atelier compacts and retries once; raise the model's context length if it is set too high. |
| "Cannot reach *Name* at *host*" | The server is down or unreachable. Retried. |
| "*Name* at *host* took too long to respond" / "…sent nothing for too long (no response for 15 minutes)" | A request that receives no bytes for 15 minutes ends. Retried. |
| "*Name* closed the stream before the response finished" | The connection dropped mid-reply. Retried. |
| "The model's reply didn't follow its own format, so *Name* couldn't read it (500)…" | A local model wrote a malformed tool call or channel header; asking again usually works. Retried twice. |
| "llama-server cannot render tool calls with its chat template. Start llama-server with --jinja (or a tool-capable --chat-template-file), or switch this model to prompted tools." | See [llama.cpp](#llamacpp). |
| "The provider for *ref* is not configured." / "*Name* is disabled." | The conversation's model belongs to a provider that was removed or switched off. |

Failures that can clear by themselves retry up to ten times, waiting 5, 10, 15, 30 and 60 seconds, then 2, 4, 8, 16 and 32
minutes; the status row shows the attempt. For anything else, **Settings › Admin › Developer** can record provider requests
(address, status, timing, never prompts or replies); see [Troubleshooting](/troubleshooting/).
