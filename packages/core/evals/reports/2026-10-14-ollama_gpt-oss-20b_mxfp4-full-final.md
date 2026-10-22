# Evals: ollama/gpt-oss-20b:mxfp4 (2026-10-14)

tier full · final. 6 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 4 | 6860 / 255 | 120.3 | 4.4s | greet.ts updated |
| fix-failing-test | pass | 6 | 7022 / 218 | 121.9 | 5s | tests pass |
| ask-clarifying-question | **fail** | 6 | 6865 / 588 | 120.6 | 7.6s | no question; tools used: Glob, Read, Read, Grep, Write |
| create-artifact | pass | 2 | 3179 / 719 | 123.9 | 7.1s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 6679 / 367 | 122.2 | 5.2s | build/ kept after the denial |
| use-skill | pass | 11 | 8036 / 975 | 119.3 | 12.4s | notes follow the skill (loaded with Skill) |
| call-mcp-tool | pass | 2 | 1114 / 61 | 125.7 | 1.6s | answered with the stock level |
