---
title: Loops and background tasks
description: Repeat a prompt with /loop, and follow the commands, sub-agents and loops a Code session keeps running beside its turns.
---

A Code session (or a Cowork task) can keep work going beside the conversation:

- **Loops** send a prompt of yours again and again, with `/loop`.
- **Background commands** are servers, watchers and long jobs the model starts with Bash and reads later.
- **Background sub-agents** are helpers the model starts and keeps working beside while they run.

All three are listed in the **Background tasks** pane. Atelier has no separate scheduler: recurring work is `/loop`.

## /loop

```text
/loop [interval] <prompt>
```

`/loop 5m check the deploy` sends "check the deploy" now, and then every 5 minutes, as if you had typed it.

| You type | What happens |
|---|---|
| `/loop 5m check the deploy` | Starts a loop that sends the prompt every 5 minutes. |
| `/loop check the deploy` | No interval: every **10 minutes**. |
| `/loop 1h30m summarize new issues` | Parts combine in the order days, hours, minutes, seconds: `1d`, `2h`, `30m`, `45s`, `1h30m`. |
| `/loop 30s …` | Shorter than a minute is rounded up to **1 minute**, and the toast says "(the shortest interval)". |
| `/loop` or `/loop list` | Opens Background tasks (in Cowork, which has no such pane, a note says how many loops run). |
| `/loop stop` | Stops all of the session's loops. |
| `/loop stop 2` | Stops the second loop of the session's list. |

The first word is read as an interval only if it looks like one. Otherwise the whole text is the prompt and the interval is 10 minutes. The longest interval is **1 day**. There is no self-pacing: the model doesn't choose when the next send comes.

A started loop shows a toast, **Loop started: every 5m**. `/loop` works in **Code** and **Cowork**, not in Chat or in a sub-agent's session (**Loops run in Code and Cowork sessions.**).

## How a send looks

Each send is an ordinary message from you, shown with a **Loop** badge above it. The model also gets a hidden note, published on [Context updates](/prompts/context-updates/): the message comes from a loop you set up, this is run N, handle it as your request, and since you may not be watching, start with what changed since the previous run.

Write the prompt so it makes sense on its own, says what to report, and says what to do when nothing changed.

## When a send happens

- **The first send is immediate**, or as soon as the session is idle.
- A send only happens while the session is **idle**. If the loop comes due while a reply is running, or a question or permission prompt waits for you, it waits until the session is idle and then sends **once**, however many intervals went by. The next interval counts from the send.
- One send at a time: if two loops are waiting, the second goes after the run the first starts.
- In Background tasks a waiting loop reads **next once the session is idle**.
- **Stop** in the session (the button, or `Esc` with an empty box) stops the response but **keeps the loops**. A waiting send is skipped, and each loop's next send comes a full interval after the Stop.

## Permissions

A loop never approves anything. Its message goes through the session's [permission mode](/permissions/) like any message you type:

- In **Auto** the reviewer decides, and what it passes runs.
- In **Ask** or **Accept edits** a prompt waits for you, and the loop's next send waits behind it. A loop with nobody there to answer stalls at the first prompt.
- In **Plan mode** the loop's runs can read and plan but not change anything.
- In **Bypass** nothing asks, so a loop runs unattended. Think before you start one there.

## What ends a loop

A loop ends when:

- you stop it (`/loop stop`, or **Stop** on its card, or **Stop loop** in its view);
- it has sent **500 times**;
- it is **7 days** old;
- you delete the session;
- the backend restarts.

Loops live in the memory of the backend that runs the session; they aren't saved. The 500 sends take about 8 hours at the 1-minute minimum and 3.5 days at the default 10 minutes; a loop with an interval of about 20 minutes or longer reaches 7 days first.

## When the app is closed, asleep or restarted

- **Window closed.** The backend keeps running, so loops keep sending. On a server your browser can be closed, and loops go on until the server restarts. In the desktop app on macOS, closing the window leaves Atelier running; on Windows and Linux, closing the last window quits Atelier, and its loops end.
- **Computer asleep.** Nothing runs while the computer sleeps, including a desktop app's backend.
- **Keep computer awake** (**More › Keep computer awake**, desktop app, Code sessions only) keeps the computer from sleeping while the session is **running or waiting for you**. Between a loop's sends the session is idle, so this switch alone does not keep the computer awake for a loop that sends every 30 minutes. If a loop must keep its schedule, keep the computer awake some other way, or run Atelier as a server.
- **Quit, update or restart.** The loops end and are not restored. A reply that was running shows **Atelier restarted and cut off this reply.** with **Continue**, which continues the reply but doesn't bring loops back.

## Limits

| Limit | Value |
|---|---|
| Loops running in one session | 5 |
| Loops running for one person, across sessions | 20 |
| Shortest interval | 1 minute |
| Longest interval | 1 day |
| Default interval | 10 minutes |
| Sends per loop | 500 |
| Lifetime of a loop | 7 days |

## Cost

Every send is a full turn: it reads the conversation so far, may call tools, and spends tokens like a message you typed. A prompt that makes the model investigate every 5 minutes spends a lot in a day: money on a hosted API, your plan's allowance with a ChatGPT sign-in, GPU time on a local model that a second session may need.

- Prefer the longest interval that serves the purpose.
- Make the prompt cheap when there is nothing new: "check X; if nothing changed since last time, say so in one line".
- Long loops make long conversations. The session [compacts](/code/#context-compaction-and-cost) automatically, but restart a loop that runs for days in a new session now and then.
- Check **Settings › Usage** after the first day.

## The Background tasks pane

Open it from **More › Background tasks**, from the **N running tasks** chip under the last turn, from `/loop`, or from a link in the conversation. The **More** menu shows a badge with the number of running tasks.

![A Code session with a pane open beside the conversation](/img/code-2560.webp)
<!-- screenshot: the Background tasks pane with a running command, a background sub-agent and a loop, each with its Stop button, and the Finished list folded below -->

The pane lists a card per task under **Running**; finished tasks fold under **Finished N** (the last 20 are kept), and **Clear finished tasks** empties them. Each card shows its title, its kind (**Bash**, **Agent** or **Loop**), **Background** for a sub-agent that works beside its parent, and how long it has run. **Stop** ends it.

| Kind | The card adds | Opening it shows |
|---|---|---|
| **Bash** | Finished: **Done**, **Stopped**, or **Exit code 1**. | **View output**: the command and its live output, read again every second while it is open. The last 100,000 characters are kept; earlier output shows as "[earlier output dropped]". |
| **Agent** | Model, tokens, tool uses and what it is doing, or **Waiting for your approval**. | **View transcript**: the model, the prompt it got, and its steps live. |
| **Loop** | **Every 5m · 3 runs · next in 4m 12s**. | **View loop**: the prompt, the schedule, when it will end on its own, and **Stop loop**. |

Running commands are checked every couple of seconds, so a command that ends appears as finished soon after. The list lives in memory per session, so a restart empties it.

## Background commands

The model starts a command in the background by calling Bash with `run_in_background`. Bash returns at once with an ID (`exec-3`); the model reads new output with BashOutput (optionally keeping only lines that match a regular expression) and stops the command with KillShell or TaskStop. Several commands started in a row share one card in the conversation (**2 background commands completed, 1 running**), each with **View output**.

- A background command has no timeout unless the model gives one.
- Stopping the response with **Stop** does **not** stop background commands. Stop them in the pane.
- Background commands stop when Atelier or its runner restarts. Asking for one by an old ID returns: **exec-3 isn't running: background commands stop when the app or its runner restarts, and this ID is from before that (or was never started). Start the command again if it's still needed.**
- Background commands run as you, in the session's folder, under the same permission rules as any command; in Auto mode starting one goes to the reviewer. A dev server the model forgets keeps running until you stop it, so look at the pane when a session is done.

## Background sub-agents

The model can hand a task to a sub-agent and keep working. Its card in the conversation says **Background**, and the same card is in Background tasks.

How the result comes back:

- Each sub-agent that ends leaves its parent a hidden note with how it ended (**has finished**, **ended without finishing**, **was stopped**) and its report, which the model reads at its next step. The conversation shows **Background agent finished · its title** with **View transcript**.
- If the parent has gone quiet, it starts a turn of its own to read the result, unless you stopped the sub-agent. It does that at most **5 times in a row** without a message from you; after that results wait for your next message. Such a turn waits while a question is open.
- A sub-agent that needs a permission asks in the parent's conversation ("Allow sub-agent “name” to run this command?"), and the session shows **Needs your attention** until you answer.
- **Stop** on the session stops running background sub-agents too. Then the model hears about them only with your next message.

Limits:

- Outside Ultracode, a session may have **8** sub-agents working in the background at once. A ninth isn't started, and the model reads **This conversation already has 8 sub-agents working in the background … Wait for the running ones.** Under [Ultracode](/effort/#ultracode) the request's budget of 24 sub-agents applies instead.
- A sub-agent takes at most **200** model calls (150 for compact-tier models), or the `maxTurns` of the agent definition. Past that it stops, and the parent reads **The sub-agent stopped at its step limit before it wrote a report, so its work may be unfinished.** with whatever the sub-agent wrote last.
- A sub-agent that errors returns **The sub-agent failed: …**.
- If Atelier shuts down while sub-agents work, they end, and the parent reads after the restart that each **was stopped because Atelier restarted**.
- On a local server that answers one request at a time, sub-agents take turns instead of working in parallel, and the card says it is waiting.

More on sub-agents, including your own agent definitions, is in [Code](/code/#sub-agents) and [Customize](/customize/).

## Cowork

`/loop` works the same way in Cowork. Loops and sub-agents that run are listed under **Background** beside the task. `/loop` alone says how many loops run in the task.

## Troubleshooting

| You see | What it means |
|---|---|
| **Add what to send every 5m, like “/loop 5m check the deploy”.** | You gave an interval and no prompt. |
| **The longest interval is 1d.** | Intervals above a day are refused. |
| **The interval has to be longer than zero.** | `0s` isn't an interval. |
| **This session already has 5 loops running, the most one session may have. Stop one first with /loop stop.** | The per-session limit. |
| **You already have 20 loops running across your sessions, the most one person may have. Stop one first with /loop stop in its session.** | The per-person limit. |
| **This session has no loops running.** | `/loop stop` found nothing. |
| **There is no loop “x” in this session.** | `/loop stop x` named a number or id that isn't there. |
| A loop has not sent for a long time | It is waiting for the session to go idle (a question or permission prompt is open), the computer slept, or it ended. Open **Background tasks**: a finished loop says **Done** (limits reached) or **Stopped**. |
| A loop disappeared after a restart | Loops aren't saved across restarts of the backend. |
