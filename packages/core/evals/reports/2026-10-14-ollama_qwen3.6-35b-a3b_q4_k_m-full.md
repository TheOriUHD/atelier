# Evals: ollama/qwen3.6-35b-a3b:q4_k_m (2026-10-14)

tier full. 5 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 4 | 8240 / 179 | 70.2 | 6.1s | greet.ts is now: export function greet(name: string): string {   return `Hi, ${name}`; }  |
| fix-failing-test | pass | 5 | 1324 / 308 | 69.7 | 7.1s | tests pass |
| ask-clarifying-question | **fail** | 3 | 1074 / 229 | 70.6 | 4.8s | no question; tools used: Bash, Glob, Read |
| create-artifact | pass | 2 | 3279 / 988 | 73.6 | 15.2s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 1069 / 82 | 70.2 | 2.6s | build/ kept after the denial |
| use-skill | pass | 4 | 8739 / 396 | 69.7 | 9.8s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 3389 / 47 | 70.7 | 2.6s | answered with the stock level |
