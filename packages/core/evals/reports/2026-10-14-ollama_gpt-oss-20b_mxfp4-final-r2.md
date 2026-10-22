# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model · final-r2. 7 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 7 | 3601 / 564 | 124 | 8.4s | greet.ts updated |
| fix-failing-test | pass | 5 | 2697 / 225 | 125.3 | 4.1s | tests pass |
| ask-clarifying-question | pass | 5 | 2761 / 873 | 123 | 8.8s | asked with AskUser |
| create-artifact | pass | 2 | 1331 / 440 | 126.2 | 4.6s | artifact: html "Click Counter" |
| respect-permissions | pass | 3 | 2580 / 802 | 126.6 | 7.7s | build/ kept after the denial |
| use-skill | pass | 9 | 3200 / 874 | 125.4 | 9.4s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 1114 / 60 | 128.8 | 1.8s | answered with the stock level |
