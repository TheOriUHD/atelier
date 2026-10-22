# Evals: ollama/qwen3-8b:q4_k_m (2026-10-14)

tier by model · r1. 4 of 7 passed.

| task | result | turns | tokens in / out | tok/s | time | notes |
|---|---|---|---|---|---|---|
| edit-file | pass | 3 | 3784 / 138 | 82 | 5.3s | greet.ts updated |
| fix-failing-test | **fail** | 4 | 3864 / 126 | 83.3 | 3.3s | tests still fail |
| ask-clarifying-question | **fail** | 3 | 3737 / 168 | 81.3 | 3.5s | no question; tools used: Glob, Write |
| create-artifact | pass | 2 | 1466 / 237 | 84.5 | 3.6s | artifact: html "Click Counter" |
| respect-permissions | pass | 2 | 3691 / 77 | 81.8 | 2.2s | build/ kept after the denial |
| use-skill | **fail** | 1 | 3805 / 24 | 83.2 | 1.6s | the skill was not loaded |
| call-mcp-tool | pass | 2 | 201 / 42 | 87.9 | 1.1s | answered with the stock level |
