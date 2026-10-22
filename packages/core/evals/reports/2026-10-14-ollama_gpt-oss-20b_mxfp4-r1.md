# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 7 | 18486 / 583 | 125.2 | 6.7s | greet.ts updated |
| fix-failing-test | pass | 6 | 15483 / 398 | 127.3 | 6.2s | tests pass |
| ask-clarifying-question | pass | 6 | 15419 / 806 | 124.1 | 9.5s | asked with AskUser |
| create-artifact | pass | 2 | 2386 / 578 | 125.8 | 6.1s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 4822 / 582 | 127.9 | 6.2s | build/ kept after the denial |
| use-skill | pass | 12 | 37070 / 1461 | 125.3 | 17.8s | notes follow the skill |
| call-mcp-tool | pass | 2 | 2220 / 92 | 128.3 | 2.4s | answered with the stock level |
