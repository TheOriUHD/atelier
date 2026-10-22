# Contributing

Atelier is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE) and maintained by one person.
Bug reports, questions and patches are welcome.

## Before you send a change

- **Bugs and ideas:** open an issue. For a bug, say what you did, what you expected, the Atelier version and your platform.
  For a security problem, do not open an issue: see [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first, so the work doesn't go somewhere it can't be merged. The product is deliberately
  small in some places, and the architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains what the pieces are for.
- **Prompts:** a change to a system prompt, note or tool description is a change to behavior. Read
  [docs/PROMPTS.md](docs/PROMPTS.md) first; the prompt snapshots in `packages/core/src/prompts/__snapshots__/` show what a
  change does to every kind of session.

## Terms of a contribution

By sending a contribution (a pull request, a patch, text in an issue that you want included) you confirm that you wrote it or
have the right to send it, and you license it under the same PolyForm Noncommercial License 1.0.0 as the rest of the project.
You also grant the maintainer a perpetual, worldwide, irrevocable, royalty-free right to use, modify and sublicense your
contribution under other terms, including commercial licenses. That right is what lets the project keep offering commercial
licenses next to the noncommercial one; you keep the copyright in what you wrote. If you do not agree, do not send it.

## Working on the code

```bash
corepack enable
pnpm install
pnpm runner:build   # the Go runner; needed to open folders for Code and Cowork
pnpm dev:desktop    # Electron with hot reload; pnpm dev:web runs the server
```

Before you send a change:

| Run | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript across every package and the e2e suite |
| `pnpm lint` | ESLint |
| `pnpm test` | The unit tests (Vitest) |
| `pnpm docs:generate` | Rewrites the generated documentation pages (prompts, tools, settings); a test fails when they are stale |
| `pnpm e2e` | Playwright against the built apps, for changes to the UI or the server (run `pnpm build` first) |

- Add or change a test with every behavior change; the tests that fail without your change are the proof it works.
- Match the code around yours: comments say why, not what, and names follow the surrounding files.
- Documentation lives in `apps/docs/src/content/docs/`. Change the page that describes the behavior you changed, and mark
  what is new on `main` with `*(next release)*`. `pnpm --filter @atelier/docs build` then `... run check` finds broken links.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` for anything people will notice, in the style of the entries
  there. Commit messages follow `type(scope): what changed` (`fix`, `feat`, `docs`, `chore`, `test`).
