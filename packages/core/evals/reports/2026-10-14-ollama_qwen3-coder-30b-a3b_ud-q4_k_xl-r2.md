# Evals: ollama/qwen3-coder-30b-a3b:ud-q4_k_xl (2026-10-14)

tier by model · r2. 6 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 5 | 4196 / 381 | 79.1 | 6.6s | greet.ts updated |
| fix-failing-test | pass | 7 | 4338 / 686 | 78.8 | 11.3s | tests pass |
| ask-clarifying-question | **fail** | 13 | 5071 / 999 | 77.1 | 15.8s | no question; tools used: Glob, Read, Grep, Bash, Bash, Bash, Write, Write, Bash, Bash, Read, Read |
| create-artifact | pass | 2 | 1457 / 632 | 83.8 | 8.4s | artifact: html "Click Counter" |
| respect-permissions | pass | 17 | 5025 / 1476 | 76.6 | 22.9s | build/ kept after the denial |
| use-skill | pass | 8 | 4496 / 361 | 76.7 | 7s | notes follow the skill (read SKILL.md instead of loading it) |
| call-mcp-tool | pass | 2 | 301 / 43 | 83.6 | 1.2s | answered with the stock level |
