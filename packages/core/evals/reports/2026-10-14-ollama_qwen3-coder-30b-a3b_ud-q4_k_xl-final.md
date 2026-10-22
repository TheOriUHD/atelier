# Evals: ollama/qwen3-coder-30b-a3b:ud-q4_k_xl (2026-10-14)

tier by model · final. 6 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 5 | 4199 / 356 | 78.7 | 13.3s | greet.ts updated |
| fix-failing-test | pass | 8 | 4387 / 546 | 77.4 | 9.8s | tests pass |
| ask-clarifying-question | **fail** | 6 | 4101 / 525 | 77.9 | 8.7s | no question; tools used: Glob, Read, Grep, Glob, Write |
| create-artifact | pass | 2 | 1475 / 625 | 83.7 | 8.2s | artifact: html "Click Counter" |
| respect-permissions | pass | 7 | 4520 / 739 | 77.5 | 11.8s | build/ kept after the denial |
| use-skill | pass | 7 | 4471 / 369 | 76.6 | 7s | notes follow the skill (read SKILL.md instead of loading it) |
| call-mcp-tool | pass | 2 | 301 / 42 | 83.7 | 1.2s | answered with the stock level |
