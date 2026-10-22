---
title: Web search
description: How Atelier searches the web and reads pages, which services see your queries, how to use a search provider of your own, and what to do when search is limited.
---

Atelier can look things up on the web. It is on by default and needs no account, key or setup: when a question needs
current information, the model searches, reads the most relevant pages and links its sources.

Two tools do the work, and each has its own switch:

| Tool | What it does | Switch |
|---|---|---|
| **WebSearch** | Turns a query into up to 10 results (title, link, snippet, and for the first few the relevant passages of the page itself). | **Web search** |
| **WebFetch** | Opens one address and returns the page as readable text, or an answer to a question about it. | **Web fetch** |

Both are offered in Chat, Cowork and Code, to sub-agents and in side chats, and keep working in plan mode. They run
in Atelier's backend (your computer with **Run on this computer**, otherwise the server), not in Chat's sandbox, so the
sandbox's network access doesn't apply. The switches are under [Settings](#settings).

## What you see

In Chat the model answers in prose, with its sources as Markdown links and a closing `Sources` section. The searches
are folded into a line such as "Used WebSearch, WebFetch" above the reply; open it to see each query, the raw input and
the result text.

In Cowork and Code every search is a step of its own: **Searched the web for** the query, with the number of results and
the engine that answered ("8 results · DuckDuckGo"). Opened, it lists the results with site, date and snippet, and
says "from this session’s cache" for a cached answer. A page read with WebFetch shows as **Fetched** and the address.
A failed search shows its reason with a **Search settings** link (to the admins' settings).

## Research

The **Research** switch is in the composer's **+** menu in Chat, on a new or open conversation. It is off by
default, belongs to the conversation, and shows only while an admin has web search on. A **Research** chip next to the
**+** shows it is active; click it to switch it off.

With Research on, every message you send carries a short note to the model: search broadly from several angles, read the
strongest sources in full, cite the ones you rely on, and point out where they disagree or the evidence is thin
(see `research` in the [context updates](/prompts/context-updates/)). That is all it changes: there is no separate
research engine, and the model decides how many searches to run. Its search instructions ([shared
prompts](/prompts/shared/#web-search)) already call for one search for a single fact and ten to twenty, plus page
fetches, for research and comparisons; Research tells it which you want.

A research answer takes longer, uses more tokens and costs the search engines more requests. Cowork and Code have no Research switch; ask for a thorough, sourced answer in your message.

## How the built-in search works

With **Search engine** on **Built-in (automatic)**, Atelier searches by itself, as a person with a browser would: it
asks public search engines and news and developer sources, with no key. Result pages are not an official API, so Atelier
spaces its requests and reports when an engine pushes back.

### Which sources a query goes to

What a query is about, judged from its words, decides which sources are asked first. The model can also name the topic
itself with the tool's `topic` parameter.

| The query is about | Sources |
|---|---|
| Anything general | DuckDuckGo, Brave, DuckDuckGo Lite and Bing, in turn (see below); Wikipedia when all of them refuse. |
| The news ("Apple event today", "announced", "who won", "this week", "earnings") | Bing News and Google News, as stories with outlet and date. The general engines are asked too when fewer than five stories come back. |
| Programming (error messages, libraries, tools, code-shaped words such as `useEffect`) | Stack Overflow, Hacker News and GitHub, with the general engines alongside. |
| Everyday lookups ("weather", "recipe", "translate", "stock price") | Always the general engines. |
| One hint of news ("new iPhone") | The general engines and the news feeds together. |

### How an answer is put together

1. The query is checked first (see [Queries](#queries-never-carry-credentials)). A cached answer from the last ten
   minutes is returned as is.
2. One general engine is asked, preferring one that can answer right away. The next is asked only when the first is
   blocked, returned an empty page, or gave fewer than four results (then the lists are merged). This keeps the load, and
   the number of services that see your query, low.
3. "No results" is reported only when a second engine agrees; if it finds results, the first is treated as
   soft-blocked. Results unrelated to the query count as empty. When no engine answers well but one returned at least
   three real pages that match only loosely (a company's own site for a product name, say), those come back with a note
   telling the model to say so.
4. If every general engine refuses, Wikipedia's search API answers factual queries, and the model is told so.
5. The results are merged by reciprocal rank, deduplicated by address, limited to three per site and ten in all, and
   cleaned (markup removed, titles cut at 200 characters, snippets at 500).
6. For the top three readable results, the page is fetched and the one or two paragraphs sharing the most words with the
   query are kept (about 700 characters). Sites that wall off scripts (Reddit, X, Facebook, Instagram, LinkedIn, TikTok,
   YouTube, Pinterest, Google News), Stack Overflow results (their snippet is the answer), redirect links, PDFs,
   archives, images, audio and video are skipped. Each page is capped at 1.5 MB and 4.5 seconds, only HTML is read, a
   redirect to another host is not followed, and WebFetch's private-address guard applies.

### What the model receives

A numbered list; news items say when and from whom; the first results carry a `Page:` line; a footer names the engine:

```text
1. Apple unveils its fall lineup
   https://example.com/news/apple-fall
   Published: Oct 13, 2026 (4 days ago) · Example Daily
   The company announced new devices at an event on Monday …
   Page: Apple said on Monday that … (about 700 characters of the page)

(via Bing News and Google News · 8 results)
```

A footer ending in `· cached` means the answer came from the cache. A note above the list says when only Wikipedia
answered, when results match only loosely, or when "only one search engine could be reached, so this may be incomplete".
Without results the model gets `No results for “query”.`

### Filters

The model, not a setting, chooses the filters; you steer them in words ("only from nytimes.com", "from this week").

- `allowed_domains` and `blocked_domains` restrict results to, or exclude, sites (subdomains count). Up to four allowed and
  five blocked domains also go into the engine's query as `site:` operators; the full lists are applied to the results as
  well.
- `freshness` (`day`, `week`, `month`, `year`) limits results to that window, through the engine's own date filter where
  it has one. Dated news results outside the window are dropped; undated pages stay.
- `topic` (`news`, `dev`, `general`) picks the sources, as above.

### Pace, health and the cache

Public search engines throttle clients that ask too fast, so Atelier spaces its requests per engine:

| Engine | Minimum gap between requests |
|---|---|
| DuckDuckGo (its HTML and Lite pages are one backend) | about 4 s |
| Bing | about 2.5 s |
| Brave | about 2 s |
| Bing News, Google News | about 1.5 s |
| GitHub | about 3.5 s |
| Stack Overflow | about 1 s |
| Hacker News | about 0.8 s |
| Wikipedia | about 0.5 s |

A little random jitter (up to 35%) is added, and at most four requests are in flight at once. A queued request leaves
the queue when you stop the response. One engine attempt gives up after 9 seconds, and one WebSearch call after 45
seconds, waiting turns included.

When an engine answers with a challenge or a refusal (HTTP 202, 403, 418, 429 or 503, a captcha or anomaly page, or GitHub's
rate limit) it is **limited**: Atelier leaves it alone for 2 minutes, then lets one request through to see if it recovered,
and doubles the pause each time it is refused again, up to 20 minutes. Three empty pages in a row that another engine
contradicted count as a refusal too. Being offline never counts against an engine.

Successful answers are cached in memory for **10 minutes**; an answer to a query with a freshness window is kept **2
minutes**. The cache holds 200 answers, is shared by everyone on the backend, and is emptied when the backend restarts.
Empty and failed answers are never cached. WebFetch has no cache.

## Reading pages with WebFetch

WebFetch opens a full `http` or `https` address and returns the page's main content as Markdown, with absolute links:
navigation and boilerplate are dropped where the page has a recognizable article, otherwise the whole body is used. It
reads HTML and XHTML, plain text, JSON, XML, YAML, TOML, CSV, SQL, source files, SVG, and PDFs. Other types come back as `Can't read <type> content.`

A page is data: the tool description tells the model to ignore instructions in it.

| Limit | Value |
|---|---|
| Response size | 10 MB (`The response is too large (12 MB).`) |
| Text handed to the model | 100,000 characters, then `[Truncated at 100,000 characters.]` |
| Time | 30 seconds |
| Redirects | Up to 5, and only within the same host. A redirect to another host is reported (`https://a.example redirects to https://b.example. Fetch that URL to continue.`) so the model can decide to follow it. |
| Credentials in the address | Refused (`URLs with embedded credentials are not fetched.`) |
| User agent | `Atelier WebFetch` |

### Answers instead of whole pages

When the model passes a `prompt` ("what are the supported platforms?"), a helper model reads the page and returns just
the answer, keeping names, numbers, dates, quotes and code exactly (instructions on
[Side prompts](/prompts/side-prompts/#web-page-questions)). The helper is the **Small model** from **Settings › Admin ›
Models** (on a server that holds one model at a time, the conversation's model). With no Small model, or none that can
answer, the page text itself goes to the conversation's model. The answer is limited to 4,000 tokens.

### Private networks

WebFetch resolves the address and refuses it if any resolved address is off limits, at every redirect hop:

| Refused | Message |
|---|---|
| `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::` | `<host> resolves to this machine, which WebFetch may not access.` |
| `169.254.0.0/16` (cloud metadata), `fe80::/10` | `… a link-local address (cloud metadata) …` |
| `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (including Tailscale-style addresses), `fc00::/7` | `… a private network address …` |
| Multicast and reserved ranges (`224.0.0.0` and up, `ff00::/8`) | `… a multicast or reserved address …` |
| A name that doesn't resolve | `Can't resolve <host>.` |

This keeps a web page from steering the model into reading Atelier's own API, your router, or a cloud provider's
metadata service. The private ranges (not this machine or link-local) can be allowed for homelab documentation by setting
`capabilities.webFetchPrivateNetworks` to `true` in the global settings file (`~/.atelier/settings.json` on the desktop,
`settings.json` in the data directory on a server). Settings has no row for it.

### Permissions

WebFetch and WebSearch are read-only, so they run without asking in every permission mode, including Auto. To make Code
or Cowork ask first, add an ask rule such as `WebFetch(domain:example.com)` or a bare `WebFetch` (**Settings › Admin ›
Code › Ask rules**); a deny rule blocks the tool. Rules cannot gate the web tools in Chat. See
[Permissions](/permissions/).

:::caution
Atelier does not ask before fetching a new domain, by default. A hostile page that the model reads could
try to make it fetch an address that carries something it has seen. Atelier's defenses are the refusal of private
addresses, the instruction to ignore directions found in pages, and the query guard below; if you work with sensitive
material, add an ask rule for `WebFetch`.
:::

## Use my own search service

Instead of **Built-in (automatic)**, **Search engine** can be one of these. Choose it in
**Settings › Admin › Capabilities › Web**.

| Choice | Needs | Endpoint |
|---|---|---|
| **SearXNG (your own)** | **SearXNG URL**, the base address of your instance, such as `https://searx.example.com`. JSON output must be enabled: add `json` to `search.formats` in its `settings.yml`. | `<URL>/search?q=…&format=json` |
| **Brave Search API** | **Search API key** | `api.search.brave.com`, header `X-Subscription-Token` |
| **Tavily API** | **Search API key** | `api.tavily.com/search`, header `Authorization: Bearer …` |

The key is saved as an encrypted secret (**Settings › Admin › Keys & secrets**, named `web-search-brave` or
`web-search-tavily`), never in a settings file; the row shows it masked once it is stored.

A provider you set up is used **alone**: queries go only there, no result pages are fetched, and there is no fallback
if it fails. Up to 20 results are requested and the same cleanup gives 10 (three per site). Domain filters go to the
provider as `site:` operators (SearXNG, Brave) or include and exclude lists (Tavily), freshness as its own time range;
the full filters are applied to the results too. Answers are cached for 10 minutes.

:::caution
A provider that isn't complete counts as **Built-in (automatic)**: with SearXNG selected and **SearXNG URL** empty, or
Brave or Tavily selected and no key, searches silently go through the built-in engines, and the status line shows the
built-in state. Fill in the URL or key first, or switch to the built-in search deliberately.
:::

A SearXNG instance on your own network is the most reliable fix when public engines refuse your address. It also keeps
queries off third parties, since your instance decides which engines it asks.

Errors from a provider reach the model as these messages (the person sees them in the failed step):

| Message | Meaning |
|---|---|
| ``SearXNG refused JSON output. Add `json` to `search.formats` in its settings.yml.`` | The instance answered 403; enable the JSON format. |
| `SearXNG answered HTTP 502.` · `Brave Search answered HTTP 429.` · `Tavily answered HTTP 500.` | The service answered with an error status. |
| `Brave Search rejected the API key.` · `Tavily rejected the API key.` | HTTP 401 or 403. |
| `timed out` | No answer within 9 seconds. |
| `Web search can't reach the internet from this computer.` | The network is down or the host doesn't resolve. |

## Settings

**Settings › Admin › Capabilities › Web** (admins only; with **Run on this computer** you are the admin):

<!-- screenshot: Settings › Admin › Capabilities › Web with the Search engine row, the status line and the Test search button -->

| Row | What it does |
|---|---|
| **Web search** | Let chats look things up on the web. Off removes WebSearch from every conversation and the **Research** switch from the composer; the model is told web search isn't on. |
| **Search engine** | **Built-in (automatic)**, **SearXNG (your own)**, **Brave Search API** or **Tavily API**. Shown while web search is on. |
| **SearXNG URL** or **Search API key** | Appears with the matching choice. |
| **Test search** | A status line and a button, below. |
| **Web fetch** | Let chats read web pages and documents by URL. Off removes WebFetch everywhere. Independent of web search. |

### The status line and Test search

With the built-in search the line under **Search engine** says how it is doing, refreshed every 15 seconds:

- `Ready. Atelier picks an engine on the first search.` before anything was searched.
- `Working. Answered by DuckDuckGo and Brave; Bing is catching its breath.` when at least one engine works and another is
  limited.
- `Search engines are limiting requests from this computer. Atelier tries again in about 2 minutes.` when every general
  engine is limited.
- Below it, one line each for the news and programming sources: `News: Bing News working, Google News not used yet.` and
  `Programming: Stack Overflow working, Hacker News limited for about 3 minutes, GitHub not used yet.`

With your own provider it reads `Using the search service you set up. Atelier does not fall back to other engines.`

**Test search** runs one real search (for the word "wikipedia", skipping the cache and filters) on the engines in use and reports
`DuckDuckGo answered in 1.2 s with 3 results.` If it fails, the reason appears under the row, such as
`The search engines are limiting requests from this computer.`

## Privacy

Searching means sending your query to someone. Which services see it depends on the query:

| What | Who sees the query |
|---|---|
| General query | The first engine that answers: DuckDuckGo (`html.duckduckgo.com`), Brave (`search.brave.com`), Bing (`www.bing.com`); a second one only when the first fails or finds little. |
| News query | Bing News and Google News (`news.google.com`), and the general engines when the feeds come up short. |
| Programming query | Stack Overflow (`api.stackexchange.com`), Hacker News (`hn.algolia.com`), GitHub (`api.github.com`), and the general engines. |
| Fallback | Wikipedia (`en.wikipedia.org`). |
| Result pages | The sites of the top three results, requested directly. |
| Your own provider | Only that provider (and for SearXNG, whichever engines it asks). |

The model writes the query and may take words from your conversation into it. The requests come from the machine
Atelier's backend runs on, so the services see its address. On the desktop app the three general engines are
asked through the app's own Chromium network stack, with its user agent and no cookies in either direction; the news feeds,
developer sources, Wikipedia, result pages and your own provider are plain HTTP requests, and a server makes all of them
with Node's HTTP client. Queries never go through an Atelier service, and there are no favicons or other decorative
third-party requests. What else Atelier contacts is on [Privacy](/privacy/).

### Queries never carry credentials

A page the model read can tell it to "search for" something it shouldn't repeat to a third party, and a query is the
cheapest way to smuggle a value out. So the query is checked before anything is sent, and refused if it:

- is shorter than 2 characters: `The query is empty.`
- is longer than 400 characters: `The query is too long (412 characters; the limit is 400). Search for the few words that matter.`
- looks like a key, token or password (an `sk-…` key, a GitHub token, an AWS key id, a Slack token, a JWT, a private
  key block) or contains the value of any secret stored in **Keys & secrets** (of 8 characters or more):
  `The query contains what looks like a credential, so it was not sent. Search without keys, tokens or passwords.`

:::note
Scraping search result pages is outside the engines' published terms, and their markup changes. Atelier keeps its volume
low, spaces its requests, caches answers and says so when an engine refuses. If that matters to you, or you
need guarantees, use a Brave Search API key, Tavily, or your own SearXNG. Public engines also refuse some networks
(datacenter and VPN addresses especially), and a Docker server has no browser stack to look like one.
:::

## When search fails

What the model is told, and what you see, when something goes wrong:

| Message | What happened | What to do |
|---|---|---|
| `Web search is unavailable right now: the search engines are limiting requests from this computer; it should clear in about 2 minutes. Tell the person, and answer from what you know, saying it may be out of date.` | Every general engine is limited and Wikipedia couldn't answer the question. | Wait, ask again, or set up your own provider. |
| `Web search is unavailable: this computer can't reach the internet. …` | Every attempt failed to connect. | Check the network (and the proxy or DNS of a server). |
| `General web search is unavailable right now (the search engines are limiting requests), so these results come from Wikipedia only. …` | The note above a Wikipedia-only answer. | Fine for facts; for news or prices, wait or use your own provider. |
| `Only one search engine could be reached, so this may be incomplete.` | One engine answered "nothing", the others couldn't be reached. | Try other words. |
| `The search took too long.` | The 45 second budget ran out. | Ask again; several searches at once queue up behind the pace limits. |
| `Fetching https://… failed with HTTP 404.` | WebFetch got an error status. | The page is gone or refuses scripts. |
| `The URL must be an absolute http(s) URL.` · `Can't resolve example.invalid.` · `Too many redirects.` · `The response is too large.` | WebFetch could not open the address as given. | Check the address; for a redirect to another host, fetch the new URL. |

When search is unavailable the model is told to tell you and to answer from what it knows, saying it may be out of date.
If it doesn't search when you expect, check that **Web search** is on and ask it to search.

## Limits

- The built-in search needs the open web to be reachable; engines refuse some addresses, and the 4-second DuckDuckGo gap
  means a burst of searches (Research) is slow by design.
- Result quality is that of public pages and feeds. Google News links are redirects that WebFetch can't open, so the
  model is told to use the headline and outlet and search for the story to get a readable link.
- The requests ask for English (an English `Accept-Language`, and the US edition of the news feeds), so results for a
  query in another language may lean English.
- The cache is in memory only: it starts empty after every restart.
