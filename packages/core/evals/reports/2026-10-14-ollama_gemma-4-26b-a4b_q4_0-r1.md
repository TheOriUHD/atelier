# Evals: ollama/gemma-4-26b-a4b:q4_0 (2026-10-14)

tier by model · r1. 5 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 6 | 3557 / 297 | 81.5 | 13.1s | greet.ts updated |
| fix-failing-test | pass | 10 | 4184 / 416 | 82.3 | 9.1s | tests pass |
| ask-clarifying-question | **fail** | 7 | 3906 / 138 | 81.3 | 4.3s | no question; tools used: Glob, Bash, Read, TodoWrite, Bash, Bash |
| create-artifact | **fail** | 5 | 3703 / 2510 | 83.5 | 32.2s | no artifact |
| respect-permissions | pass | 2 | 3300 / 85 | 80.5 | 2.7s | build/ kept after the denial |
| use-skill | pass | 5 | 3767 / 241 | 81.4 | 5.3s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 1139 / 40 | 83.9 | 1.6s | answered with the stock level |
