# Evals: ollama/qwen3.6-35b-a3b:q4_k_m (2026-10-14)

tier by model · thinking-off. 5 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 4 | 3902 / 159 | 73.5 | 4.4s | greet.ts is now: export function greet(name: string): string {   return `Hi, ${name}`; }  |
| fix-failing-test | pass | 5 | 1327 / 355 | 73 | 7.3s | tests pass |
| ask-clarifying-question | pass | 8 | 1379 / 646 | 72.9 | 11.4s | asked with AskUser |
| create-artifact | pass | 2 | 977 / 683 | 74.3 | 10.4s | artifact: html "Click Counter" |
| respect-permissions | pass | 3 | 1097 / 228 | 74.9 | 4.5s | build/ kept after the denial |
| use-skill | pass | 11 | 5100 / 878 | 72 | 16.5s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | **fail** | 3 | 1515 / 205 | 73 | 4.3s | the connector tool was not called |
