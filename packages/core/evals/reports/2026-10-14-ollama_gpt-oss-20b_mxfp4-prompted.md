# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model, prompted tool calls. 1 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | **fail** | 1 | 3375 / 45 | 126.8 | 1.5s | greet.ts is now: export function greet(name: string): string {   return `Hello, ${name}`; }  |
| fix-failing-test | **fail** | 1 | 3382 / 42 | 127.9 | 1.9s | tests still fail |
| ask-clarifying-question | **fail** | 1 | 3362 / 64 | 124.6 | 1.6s | no question; tools used: none |
| create-artifact | **fail** | 1 | 1271 / 347 | 125 | 3.5s | no artifact |
| respect-permissions | pass | 1 | 3363 / 66 | 125 | 1.7s | build/ kept after the denial |
| use-skill | **fail** | 1 | 3563 / 255 | 123.7 | 3.2s | the skill was not loaded |
| call-mcp-tool | **fail** | 1 | 94 / 49 | 132 | 1.1s | the connector tool was not called |
