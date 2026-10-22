# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier full. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 4 | 6828 / 302 | 122.5 | 4.8s | greet.ts updated |
| fix-failing-test | pass | 7 | 7111 / 501 | 120.6 | 8.6s | tests pass |
| ask-clarifying-question | pass | 6 | 7012 / 1075 | 119.4 | 13.3s | asked with AskUser |
| create-artifact | pass | 2 | 3109 / 815 | 124.4 | 8.6s | artifact: html "Click Counter Page" |
| respect-permissions | pass | 2 | 6679 / 321 | 122.2 | 5.2s | build/ kept after the denial |
| use-skill | pass | 8 | 8158 / 824 | 117.8 | 10.8s | notes follow the skill |
| call-mcp-tool | pass | 2 | 2882 / 123 | 124.7 | 3.3s | answered with the stock level |
