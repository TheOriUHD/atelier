# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model · final-r1. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 7 | 3193 / 396 | 124.8 | 12.1s | greet.ts updated |
| fix-failing-test | pass | 6 | 3120 / 273 | 125.6 | 4.9s | tests pass |
| ask-clarifying-question | pass | 7 | 2884 / 958 | 122.8 | 9.9s | asked with AskUser |
| create-artifact | pass | 2 | 1390 / 393 | 125.7 | 4.1s | artifact: html "Click Counter" |
| respect-permissions | pass | 3 | 2568 / 442 | 122 | 4.9s | build/ kept after the denial |
| use-skill | pass | 9 | 3256 / 724 | 125.2 | 8.2s | notes follow the skill (read SKILL.md instead of loading it) |
| call-mcp-tool | pass | 2 | 1114 / 56 | 128.6 | 1.4s | answered with the stock level |
