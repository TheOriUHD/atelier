# Evals: ollama/qwen3.6-35b-a3b:q4_k_m (2026-10-14)

tier by model, effort high · thinking-on. 5 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 4 | 3892 / 270 | 73.1 | 5.9s | greet.ts is now: export function greet(name: string): string {   return `Hi, ${name}`; }  |
| fix-failing-test | pass | 5 | 1637 / 460 | 72.6 | 9s | tests pass |
| ask-clarifying-question | **fail** | 3 | 1104 / 571 | 74.3 | 9.2s | no question; tools used: Glob, Glob, Glob, Glob, Glob, Read, Bash |
| create-artifact | pass | 2 | 971 / 661 | 75 | 10.1s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 1070 / 249 | 74.5 | 4.7s | build/ kept after the denial |
| use-skill | pass | 5 | 4227 / 445 | 72.6 | 8.8s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 1485 / 135 | 73.9 | 3.2s | answered with the stock level |
