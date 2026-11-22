---
title: Decision models
description: "Models that pick instead of write: give them a text and a few options, and they answer with the likeliest one in about a tenth of a second. On your own GPU with Ollama, or from TypeSafe Jev, OpenAI or OpenRouter."
---

A decision model doesn't write. It reads a text and answers questions about it with probabilities: **yes or no**, **one
of a few options**, or **a level on a scale**. It takes about a tenth of a second and costs a fraction of a chat model's
call, so Atelier uses one where a whole model call is too slow for a small decision, and lets you and the assistant use
it too.

- **You** can ask it directly in the [Decide window](#the-decide-window) or with [`atelier decide`](#in-the-terminal).
- **The assistant** can [sort many things at once](#the-decide-tool) with it: hundreds of issues, emails or search
  results, each judged in a tenth of a second.
- **Auto mode** can [check actions with it first](#auto-modes-quick-check), so an action that is plainly fine doesn't
  wait seconds for the reviewer.
- **Atelier itself** uses it for [small choices](#small-choices).

## Get one

Most setups need nothing new: a decision model of a provider you already have shows up by itself.

| Where | How |
|---|---|
| **Ollama** 0.35 or later, on your computer or your server | `ollama pull nimble` (9 GB, Apache 2.0) or `ollama pull tev1` (4.4 GB, MIT). The [Ollama provider](/providers/) you have finds them. |
| **LM Studio** with a decision model loaded or downloaded (from its model catalog) | Your LM Studio provider (OpenAI-compatible, `http://localhost:1234/v1`) offers it: LM Studio's own model list says which models decide, and Atelier loads one that isn't loaded. LM Studio has decision models only in its recent versions; an older one answers "Unexpected endpoint or method", and Atelier says to update it. |
| **llama.cpp**'s `llama-server` with a decision model (OpenJev, Laya, Julia…) | Your llama.cpp provider offers it, by its name. Or add the server as **Another System One server** (below). |
| **TypeSafe Jev**, the decision model this kind started with | Add it in **Settings › Admin › Decision models** with a key from the [TypeSafe console](https://console.typesafe.ai/keys). You pay for what it reads; it writes nothing. |
| **OpenAI**'s Decisions API (`gpt-6-luna`) | Your OpenAI provider with an API key offers it. Choose it by name: Atelier never starts paying for one on its own. |
| **OpenRouter** or **Requesty** | Your provider for them offers their decision models. Choose one by name, as for OpenAI. |
| **Decision Models** (open-weight models, servers in the EU) or any server that answers `POST /v1/systemone` | Add it in **Settings › Admin › Decision models**. |

With none chosen, Atelier uses a service you added for decision models, else one on a server you run (nimble before
tev1). A model of a provider you pay per request (OpenAI, OpenRouter) is used only when you choose it.

**A model of a provider you have.** When a server can't say which of its models decide (an OpenAI-compatible server
elsewhere, an older listing), choose **A model of a provider…** in the Decision model list, pick the provider and type
the model's name as its server knows it. **Try** asks it a yes-or-no question first. Atelier asks such a server in
TypeSafe's System One format first and in OpenAI's Decisions format when it doesn't know that one, and remembers which
worked.

**Which one?** On an AMD Radeon AI PRO R9700 with Ollama 0.40.17 we measured a check of an action at 180 ms with nimble
and 105 ms with tev1, once loaded (the first call loads the model: 3.5 to 5 seconds). nimble judged 12 of our 14 test
actions as expected and approved no risky one; tev1 was too unsure to approve anything on its own, so it is better for
sorting than for Auto mode.

## Settings › Admin › Decision models

- **Decision models** on or off for everyone.
- **Decision model**: the one Atelier asks, or **Automatic** (see above). Each is marked as running on a server you run
  or as a paid service. **A model of a provider…** names one of a provider you have.
- **Services**: TypeSafe Jev, Decision Models or another System One server, with its address and key. **Test** asks it
  a question before you save it.
- **Auto mode check**, **Decide tool** and **Small choices**: what it is used for, below.
- **Try it** opens the Decide window.

## The Decide window

Paste or type a text, add one or more questions, and press **Decide** (⌘Enter or Ctrl+Enter). Each question is:

- **Yes or no**: the answer is the probability of yes ("Yes, 92%").
- **Pick one**: two or more options; each gets its probability, and the likeliest is marked.
- **Score**: two to ten levels, lowest first; each gets its probability, plus the expected level ("1.7 of 0-2").

An option can say what it means, which helps the model: "bug: something that worked and broke". The window shows which
model answered and how long it took. It is open to everyone when the server has a decision model.

## In the terminal

The [terminal app](/cli/) asks it too, which suits scripts:

```bash
atelier decide "The app crashes when I export a PDF" --choice "bug,question,feature" --question "What is this?"
```

```bash
cat issues.txt | atelier decide --lines --yes-no "Is this a bug report?"
```

`--score "low,medium,high" --question …` rates on a scale, `--questions file.json` asks many questions at once,
`--lines` judges each line of the input on its own, and `--json` prints the raw answers. `atelier decide --list` shows
the model in use. See the [terminal app's reference](/reference/cli/).

## The Decide tool

With **Decide tool** on, the assistant has a **Decide** tool: it hands the decision model up to 200 texts and up to 8
questions per call and gets back, for each text, the likeliest answers with their probabilities, plus a count per
option. It uses it to triage and filter (which of these issues are bugs, which emails need an answer today, which search
results are about the question) and reads only the ones that matter itself. A decision model never writes, so the
assistant still writes the answers and the reasons.

## Auto mode's quick check

In [Auto mode](/permissions/#auto-mode) a reviewer model looks at each action that needs it, which takes a few seconds
each time. A decision model can look first, at the same account of the turn the reviewer gets:

- **Compare with the reviewer** (the default once you have a decision model): it looks at each action beside the
  reviewer, and nothing changes. The page shows how they agreed: how often both allowed an action, how often it left one
  to the reviewer, and the actions it would have let through that the reviewer stopped, with the reviewer's answer.
- **Approve what it is sure of**: an action it is sure is plainly part of what you asked and harmless runs at once,
  without the reviewer. Anything else goes to the reviewer as before, which also writes the reasons a decision model
  can't.
- **Off**.

It never makes Auto mode more permissive than the reviewer's rules: dangerous commands, anything outside the project's
folder, connectors and Atelier's own configuration ask you as before, and a co-op guest's actions always go to the
reviewer. Compare first, look at the misses, and switch to approving when you trust it.

## Small choices

With **Small choices** on, Atelier asks the decision model instead of guessing from keywords:

- **Whether a reply asks you something**, which decides whether a task with open items goes on by itself or waits for
  you ("Shall I go on with the migration, or stop here." asks too).
- **Which engines a web search goes to** (news, programming or anything else), for Atelier's own search.
- **Whether a conversation has anything to remember**: when it is sure there isn't, the memory update skips reading it.

Each falls back to the old way when there is no decision model or it doesn't answer in time.

## Sharing a GPU

A decision model on the same Ollama as your chat models waits for its turn there like any other request, and Ollama
keeps it loaded for 30 minutes after its last use, so the next one is quick. If your server holds several models at once
(Ollama's `OLLAMA_MAX_LOADED_MODELS`), set **Models at once** on the Ollama provider to the same number, so a decision
doesn't wait for a reply to finish. Loaded, nimble takes about 9 GB of video memory and tev1 about 5 GB.

## What is sent where

A decision model reads what it is asked about: the text in the Decide window, the items of the Decide tool, the end of a
reply, a search query, part of a conversation for memory, and for Auto mode the same account of the turn the reviewer
reads (your recent messages, the agent's recent actions and the one it wants to take). On your own Ollama or llama.cpp
that stays on your server; a service (TypeSafe, OpenAI, OpenRouter, Decision Models) receives it like a chat model
receives a conversation.
