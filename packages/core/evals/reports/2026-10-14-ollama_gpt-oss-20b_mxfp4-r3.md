# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model · r3. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 8 | 3056 / 1286 | 124.3 | 12.8s | greet.ts updated |
| fix-failing-test | pass | 6 | 2745 / 297 | 127.2 | 6s | tests pass |
| ask-clarifying-question | pass | 13 | 3337 / 2037 | 124.7 | 20s | asked with AskUser |
| create-artifact | pass | 2 | 1339 / 410 | 126.2 | 4.7s | artifact: html "Click Counter Page" |
| respect-permissions | pass | 2 | 2452 / 265 | 127.4 | 3.7s | build/ kept after the denial |
| use-skill | pass | 15 | 4296 / 1610 | 125.1 | 17.2s | notes follow the skill |
| call-mcp-tool | pass | 2 | 1114 / 147 | 127.6 | 3.9s | answered with the stock level |
