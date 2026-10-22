# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier by model · r2. 6 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 7 | 2977 / 688 | 125.6 | 7.7s | greet.ts updated |
| fix-failing-test | pass | 6 | 3112 / 280 | 127.1 | 5.7s | tests pass |
| ask-clarifying-question | pass | 8 | 2840 / 1467 | 124.1 | 15.4s | asked with AskUser |
| create-artifact | pass | 2 | 1339 / 468 | 125.7 | 5s | artifact: html "Click Counter" |
| respect-permissions | pass | 3 | 2571 / 706 | 125.8 | 8.8s | build/ kept after the denial |
| use-skill | **fail** | 14 | 3846 / 1530 | 125.2 | 18.6s | RELEASE_NOTES.md does not follow the skill; The model's reply didn't follow its own format, so Eval couldn't read it (500): llama-server chat error: map[code:500 message:The model produced output that does not match the expected peg-native format type:server_error] |
| call-mcp-tool | pass | 2 | 1114 / 76 | 128.6 | 2.2s | answered with the stock level |
