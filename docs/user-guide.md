# Atelier user guide

The user documentation is the documentation site: **https://docs.atelierhq.dev**. Its pages are in this repository under
[`apps/docs/src/content/docs/`](../apps/docs/src/content/docs), so a change to how something works can change its page
in the same commit.

| I want to… | Page |
|---|---|
| Install Atelier and add a model | [Getting started](../apps/docs/src/content/docs/getting-started.md), [Install](../apps/docs/src/content/docs/install.md), [Providers](../apps/docs/src/content/docs/providers.md) |
| Use Chat, Cowork or Code | [Chat](../apps/docs/src/content/docs/chat.md), [Cowork](../apps/docs/src/content/docs/cowork.md), [Code](../apps/docs/src/content/docs/code.md) |
| Run a server for other people | [Self-hosting](../apps/docs/src/content/docs/self-hosting.md), [Accounts](../apps/docs/src/content/docs/accounts.md) |
| Read the system prompts | [System prompts](../apps/docs/src/content/docs/prompts/index.md) |
| Look up a setting or a tool | [Settings reference](../apps/docs/src/content/docs/reference/settings.md), [Built-in tools](../apps/docs/src/content/docs/reference/tools.md) |

The prompt, tool and settings pages are generated from the code; `pnpm docs:generate` rewrites them and a test fails when
they are stale. The documentation site is built with `pnpm --filter @atelier/docs build`, and
`pnpm --filter @atelier/docs run check` looks for broken internal links in the result.
