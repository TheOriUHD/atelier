# Evals: ollama/qwen3-8b:q4_k_m (2026-10-14)

tier by model, effort high · thinking-on. 6 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 5 | 3810 / 1142 | 78.9 | 16.1s | greet.ts is now: export function greet(name: string): string {   return `Hi, <name>!`; }  |
| fix-failing-test | pass | 6 | 3850 / 1288 | 78.3 | 18.5s | tests pass |
| ask-clarifying-question | pass | 3 | 3654 / 840 | 78.8 | 12.2s | asked with AskUser |
| create-artifact | pass | 2 | 1261 / 576 | 82.9 | 7.7s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 3650 / 802 | 78.9 | 11.5s | build/ kept after the denial |
| use-skill | pass | 3 | 3977 / 1198 | 78.2 | 17s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 169 / 280 | 84.6 | 4s | answered with the stock level |
