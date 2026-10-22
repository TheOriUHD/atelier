---
title: ChatGPT
description: The two ways to use a ChatGPT subscription in Atelier, ChatGPT Plan and the experimental ChatGPT Chat, with how each works, what each risks and which to choose.
---

If you pay for ChatGPT, Atelier can use that subscription instead of an API key, in two quite different ways. **ChatGPT
Plan** signs in the way OpenAI's Codex does and talks to the backend Codex uses. **ChatGPT Chat** drives the ChatGPT web
page in a hidden browser window. Neither is an API OpenAI documents for other programs, so both can change or stop working,
and the second is far more fragile.

:::caution
Both are unofficial. If you need something that will not break without notice, use an API key
([OpenAI](/providers/#openai) or [Anthropic](/providers/#anthropic)) or a [local model](/local-models/).
:::

<!-- screenshot: the red ChatGPT Chat warning, and the card after it with the Sign in to ChatGPT button -->

## The two compared

| | **ChatGPT Plan** | **ChatGPT Chat** |
|---|---|---|
| Provider type | `chatgpt`, named "ChatGPT Plan" | `chatgpt-chat` |
| How it connects | Signs in as Codex does; calls ChatGPT's Codex backend (the Responses API) | A hidden browser window signed in to chatgpt.com, driven by Atelier |
| Where | Desktop app and servers | Desktop app only |
| Status | Unofficial: not documented by OpenAI as an API | Experimental; automated use of the web app may conflict with OpenAI's terms |
| Models | Your account's own model list | Read from ChatGPT's own model picker (for example GPT-6 and GPT-5.6 Sol) |
| Effort | Low to Max; the model's own levels come from Atelier's catalog, else your account | ChatGPT's own stops: Instant, Medium, High, Extra High, Pro (only those your plan has) |
| Ultracode | Offered in Code | Not offered |
| Tool calling | Native | Prompted, in fenced blocks, with corrections |
| Images and PDFs | Images; PDFs where Atelier knows the model takes them | Images and PDFs as attachments (up to 10 files, 20 MB each) |
| Context | Your account's window | 128,000 tokens, fixed |
| Usage | The plan's usage windows in Code's context popover | Not shown; ChatGPT's own limits apply |
| Several requests at once | As a hosted API | Exactly one conversation slot |
| Auto mode | Reviews as usual | Never reviews through it |
| Cost | No per-token price; it uses your plan | Uses your plan; Pro mode has its own small allowance |
| On a server | Yes, with a device code; everyone uses the admin's plan | No |

## ChatGPT Plan

### Sign in

- **Desktop app:** **Settings › Admin › Providers › Add provider › ChatGPT Plan › Sign in with ChatGPT** opens your browser;
  after you sign in to ChatGPT there, the browser sends the result to Atelier on `localhost:1455` and the provider is added.
  The sign-in lasts 5 minutes. Port 1455 must be free (the Codex command-line tool uses it too).
- **Server (web):** the same button shows a one-time code and a link to OpenAI's verification page (auth.openai.com/codex/device).
  Enter the code and approve within **15 minutes**. If OpenAI asks, enable device code login in your ChatGPT security settings
  or ask your workspace admin.
- Sign-in is not offered once the provider is added. After an expiry, **Remove** the provider and add it again.

Atelier signs in on its own and does not read or share Codex's login: refresh tokens are single use, so two programs sharing
one login would sign each other out. The tokens are kept encrypted in Atelier's secret store and renewed shortly before they
expire. On a server, everyone who can use the provider uses the admin's plan.

### What you get

- **Models:** the list your account's backend gives for Codex clients, in its own order, with the reasoning levels it reports,
  the account's context window (else Atelier's catalog value, else 272,000 tokens) and vision. If the list cannot be read,
  Atelier shows the usual ids (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`) with a warning.
- **Effort:** Low to Max as for any model. Max is sent as `xhigh`, the highest level of the Responses API, and a model Atelier
  knows is never sent a level it does not have. **Max output** and **Temperature** overrides have no effect: Atelier removes them
  from the request, because the backend refuses them.
- **The provider row** shows your email and plan, for example "you@example.com · Plus plan".
- **Usage windows:** in Code, the ring next to the composer opens a popover, **Plan usage limits**, with a bar and a reset time
  for the "5-hour limit" and the "Weekly limit", amber from 75% and red from 90%. Atelier reads them from your account the way
  Codex's status does (at most every 30 seconds), and each reply's headers update them. Before the first reply the popover may
  say "ChatGPT reports your usage with each reply: it shows after the next message."
- **Pro plans** show as **Pro 100**, **Pro 200** or **Pro 500**, and only their weekly window, because those plans have no
  5-hour window.

<!-- screenshot: Code's context popover showing Plan usage limits for a ChatGPT Plan session -->

When your plan's limit is reached, the turn ends at once with "*Name* usage limit reached: …" rather than
retrying.

### What Atelier sends

Your conversation goes to `chatgpt.com/backend-api/codex` with your account's token and ID, an installation ID, and the client
name `atelier`; the sign-in itself uses the same public client ID Codex uses. The usage windows come from
`chatgpt.com/backend-api/wham/usage`. To list the newest models, Atelier also looks up the current version of OpenAI's Codex
package on the public npm registry (cached six hours; a built-in version is used if that fails). Removing the provider signs
you out and deletes the stored sign-in.

## ChatGPT Chat

:::caution
Experimental, desktop only, and fragile. It automates the ChatGPT web page, and OpenAI's terms may not allow that (Atelier's
own dialog says "automated access may conflict with OpenAI’s terms"). Atelier cannot tell you whether or how OpenAI acts on it
for your account. When ChatGPT changes its page, this can stop working until Atelier catches up.
:::

### How it works

Atelier opens a browser window on chatgpt.com with its own, separate cookie storage, and keeps it hidden except when you sign
in or choose **Open ChatGPT session**. Closing it only hides it. For each message Atelier sets the model and effort in
ChatGPT's picker, types your message, clicks Send, watches the reply appear, and reads the page's markup back as Markdown
(tables, fenced code and math as TeX included). A reply counts as finished only after it looked finished twice in a row. The
window denies browser permissions (camera, location and so on) and blocks pop-ups.

### Add it

1. **Settings › Admin › Providers › Add provider › ChatGPT Chat**. It is only listed in the desktop app.
2. Read the warning and continue.
3. **Sign in to ChatGPT** opens the window. Sign in there yourself; Atelier never types your credentials. This is a separate
   sign-in from **ChatGPT Plan**.
4. When Atelier detects the session it says "ChatGPT session connected. Ready to add." Choose **Add ChatGPT Chat**.

The provider's ⋯ menu has **Test connection**, **Open ChatGPT session** (shows the window, to sign in again or answer a
prompt ChatGPT shows), **Temporary chats**, and **Remove** (clears the private browser session and removes its model from the
picker; your Atelier conversations stay in your history). There is no **Edit**.

### Temporary chats

**Temporary chats** (on by default) makes Atelier use ChatGPT's own temporary chats, which stay out of your ChatGPT history and
are neither shaped by nor added to its memory. Turn it off and the conversations appear in your ChatGPT history like any
other. This is ChatGPT's feature, not Atelier's [temporary chats](/chat/).

### Models and effort

<!-- screenshot: the effort popover for GPT-6 showing ChatGPT's stops, with Pro drawn in violet -->

The model list and the effort control come from ChatGPT's own picker, which Atelier reads from the page (at most every ten
minutes, and not while a reply is being written). Today that is **GPT-6** and **GPT-5.6 Sol**, each with the stops
**Instant**, **Medium**, **High** and, on the higher plans, **Extra High** and **Pro**. These stops replace the Low to Max
scale as the effort control, and a stop your plan locks is not offered. Before each message the page is set to your model and
stop if it differs.

- **Pro** is ChatGPT's most capable setting: slow, with its own much smaller allowance. The effort control draws it like
  Ultracode as a look only; it sends Max, with none of Ultracode's behavior.
- **Starting level:** Medium in Chat, High in Cowork and Code.
- **If the list cannot be read** (not signed in, the page not loaded), Atelier lists a single model, **ChatGPT Chat**, that uses
  whatever model and setting the page already has; the effort levels then only change what the model is asked.
- **While ChatGPT thinks**, the status row reads "Thinking…", then "Still thinking, a high effort setting can take a few
  minutes…" after two minutes and "Still thinking, this is taking much longer than usual…" after ten. ChatGPT's thinking
  steps are not shown, only the answer.
- **Context** is fixed at 128,000 tokens, a little under the smallest window ChatGPT gives here (Instant 137k; the thinking
  settings 262k, Pro 410k). A request estimated not to fit stops before anything is sent.

### Images and PDFs

Images (PNG, JPEG, WebP, GIF) and PDFs go to ChatGPT as attachments: at most **10** files in one message (the most recent
ones) and **20 MB** each. In the whole conversation Atelier also keeps only the newest 10 images; older ones become a note to
the model ("An earlier image is left out: a request can hold at most 10 images"). A text document is put into the message.
A message in a continuing conversation sends only the files it adds.

### Tool calls

ChatGPT's page gives the model tools of its own, including a Python sandbox, and left alone it often uses them: it runs a
command or fetches a page in its sandbox and reports a result that never happened on your computer, or says "I can't run
that from this chat, please paste the output". Atelier works around it:

1. Tools reach the model as text, as for any [prompted](/models/#tool-calling-native-prompted-none) model, and each call is asked for
   inside a fenced code block, which the page shows exactly as written (so file names, globs and URLs survive its formatting).
2. The first message opens with a short framing ("A program runs this chat… you have no tools of your own"), and every message
   ends with a one-line reminder.
3. When a reply has no tool call but reads like a sandbox result or a refusal, Atelier sends a correction in the same chat
   and takes the reply back, twice at most.
4. A refusal that survives both corrections is the answer. A reply that is still from the sandbox fails the turn with
   "ChatGPT used its own sandbox instead of Atelier’s tools, so what it reports did not happen on your computer. Send the
   message again."

On the real page, with six everyday requests, about two thirds went to the right tool without this and 18 of 18 with it (4
needed one correction, taking 9 to 17 seconds instead of 4 to 8). Connector tools are listed on request (`ToolSearch`) so the
prompt stays small.

### One conversation slot

ChatGPT Chat takes one request at a time, and every request is a message from your plan.

- The first message sends the whole conversation; later messages type only what is new into the same ChatGPT chat, which keeps
  its own context. Atelier starts a new ChatGPT chat with everything when the conversation changed (an edit, a retry, a
  stopped reply), when you switch conversations, or when a sub-agent runs.
- Sub-agents take turns, and each of their requests is a message too.
- **Auto mode never reviews through it.** A review would take the one slot and cost a message each time, so the **Small model**
  reviews, and when there is no other model the action is asked instead: "Auto mode has no other model than ChatGPT Chat to check
  this action. Set a small model in Settings › Admin › Models, or pick another permission mode." See [Permissions](/permissions/).
- **Titles** are not written by ChatGPT; a conversation is titled with the first words of your message unless a Small model
  writes a title.
- Set a **Small model** that is not ChatGPT Chat (see [Models](/models/#small-model)); otherwise summaries and memory updates
  run through ChatGPT too.

### Limits and what it cannot do

- **ChatGPT's limits apply** and Atelier cannot see how much is left: the plan bars of ChatGPT Plan do not exist here. When the
  page shows an alert, the turn ends with the alert's text. No token counts or costs come from ChatGPT.
- It exists only in the desktop app, which hosts the browser window: not on a server, not in a browser tab, not while the app
  is closed.
- It has been checked against the live page: formatting, continuing a chat, temporary chats, model and effort selection and
  tool calls. A long Code session on it has not been run end to end, and Windows and Linux are less exercised than macOS.

## Which one should I use

| If you want… | Use |
|---|---|
| A ChatGPT subscription's models with real tool calling, images, a server, and the plan's usage shown | **ChatGPT Plan** |
| The least that can break | An API key (**OpenAI** or **Anthropic**), or a local model |
| The models and Pro mode of the ChatGPT web app itself, and you accept it is fragile and may not be allowed | **ChatGPT Chat**, on the desktop, with a Small model set |
| To share a subscription with a team on a server | **ChatGPT Plan** only, and only where sharing one plan is allowed |

Start with ChatGPT Plan. Add ChatGPT Chat only if you need what the web app has.

## Troubleshooting

### ChatGPT Plan

| Message | What it means |
|---|---|
| "Sign in with ChatGPT in Settings › Admin › Providers." | Nobody is signed in. Remove the provider and add it again. |
| "Your ChatGPT sign-in has expired or was revoked. Sign in again." | The refresh token was refused for good. Remove the provider and add it again. |
| "Port 1455 is in use, probably by another sign-in (is the Codex CLI signing in?). Finish or close it and try again." | Another sign-in holds the callback port. |
| "The sign-in timed out. Start it again." | The 5 minute browser sign-in ran out. |
| "The device sign-in timed out after 15 minutes. Start it again." | You did not approve the code in time. |
| "ChatGPT could not start device sign-in. Try again." / "ChatGPT could not complete device sign-in. Start it again." | OpenAI's device endpoint refused or failed; check that device code login is enabled. |
| "ChatGPT did not sign you in (…)." | The sign-in page reported an error, given in the parentheses. |
| "This ChatGPT account has no plan to sign in with." | The account has no ChatGPT subscription. |
| "The account's model list could not be read, so the models shown are the usual ones." | A warning: the list moved or OpenAI was unreachable. |

### ChatGPT Chat

| Message | What it means and what to do |
|---|---|
| "ChatGPT Chat requires the desktop app." | It only works in the desktop app. |
| "Open the ChatGPT session to sign in." | Not signed in. Use ⋯ › **Open ChatGPT session**. |
| "Finish signing in in the ChatGPT session first." | The window is not on chatgpt.com. Finish signing in. |
| "ChatGPT’s message field did not become ready. Open the ChatGPT session to check for sign-in or a page update." | No message box appeared within 20 seconds. Open the session and look. |
| "ChatGPT’s message field changed before typing. Open the ChatGPT session to inspect it." | The page changed under Atelier. |
| "ChatGPT’s message field does not contain the complete intended text. Your message was not submitted." | Nothing was sent; try again. |
| "ChatGPT’s Send button is missing or disabled. Open the ChatGPT session to check the page. Your message was not submitted." | Nothing was sent. The page may show a prompt that needs you. |
| "ChatGPT could not send the message. Open the ChatGPT session to inspect it." | Sending failed after typing. |
| "ChatGPT does not offer *stop* on this account right now. Pick another effort." | Your plan locks that stop. |
| "ChatGPT’s model picker does not list *model*. Pick another model." | The list changed. |
| "Atelier could not set *stop* in ChatGPT’s picker. Pick another effort, or open the ChatGPT session to check." | The slider did not move to that stop. |
| "ChatGPT did not take the attachments. Open the ChatGPT session to check the page." / "ChatGPT did not finish taking the attachments. Open the ChatGPT session to check them." | An upload failed or took over three minutes. |
| "*file* is larger than the 20 MB ChatGPT takes. Use a smaller file." | Too big for ChatGPT. |
| "The ChatGPT Chat request exceeds its configured context budget. No message was submitted. Reduce attached context or loaded connector tools." | The request is estimated to be over the 128,000 token window less room for the reply. Shorten the conversation, attach less, or start a new one. |
| "ChatGPT used its own sandbox instead of Atelier’s tools, so what it reports did not happen on your computer. Send the message again." | See [Tool calls](#tool-calls). |
| "Atelier could not confirm the ChatGPT reply before the timeout. Open the ChatGPT session to check whether it answered before sending again." | No reply was confirmed in 15 minutes, or nothing started in one minute. Check the session before resending. |
| "Auto mode has no other model than ChatGPT Chat to check this action…" | Set a Small model or change the permission mode. |

Other things to try: **Open ChatGPT session** and look at the page; sign in again; **Remove** the provider and add it again, which
clears the private session.
