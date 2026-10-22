# Evals: ollama/qwen3.6-35b-a3b:q4_k_m (2026-10-14)

tier by model · baseline. 5 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 5 | 4091 / 379 | 73.8 | 7.9s | greet.ts is now: export function greet(name: string): string {   return `Hi, ${name}`; }  |
| fix-failing-test | pass | 5 | 1551 / 554 | 73.9 | 15.3s | tests pass |
| ask-clarifying-question | **fail** | 2 | 1386 / 528 | 74.1 | 13.9s | no question; tools used: Bash, Bash |
| create-artifact | pass | 2 | 1889 / 606 | 75.1 | 14.7s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 1115 / 233 | 74.1 | 9.8s | build/ kept after the denial |
| use-skill | pass | 5 | 4839 / 692 | 72.9 | 17.8s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 1726 / 573 | 73.8 | 14.5s | answered with the stock level |
