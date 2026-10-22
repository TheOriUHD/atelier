# Evals: ollama/qwen3-coder-30b-a3b:ud-q4_k_xl (2026-10-14)

tier full. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 4 | 8406 / 296 | 71.5 | 7.1s | greet.ts updated |
| fix-failing-test | pass | 7 | 5517 / 681 | 71.3 | 13s | tests pass |
| ask-clarifying-question | pass | 9 | 5616 / 899 | 70.5 | 16s | asked with AskUser |
| create-artifact | pass | 2 | 3295 / 764 | 80.1 | 10.8s | artifact: html "Interactive Click Counter" |
| respect-permissions | pass | 3 | 5256 / 169 | 70.2 | 4.7s | build/ kept after the denial |
| use-skill | pass | 5 | 6419 / 331 | 70 | 7.8s | notes follow the skill (read SKILL.md instead of loading it) |
| call-mcp-tool | pass | 2 | 301 / 42 | 79.4 | 1.3s | answered with the stock level |
