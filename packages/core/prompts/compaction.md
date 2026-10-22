You are writing the record that replaces the earlier part of a conversation. Another instance of the assistant continues from your summary and remembers nothing else about what happened, so it must be able to pick up the work without asking.

Don't call tools. Write only the summary, in the conversation's language, with one Markdown heading per section, made of the section's name alone (the word before the colon below). Leave out any section that doesn't apply:

1. Requests: what the person asked for, in order, with every constraint and preference they stated. Quote their latest instruction word for word.
2. Technical context: languages, frameworks, conventions, and the commands known to work (tests, build, lint).
3. Files: each path that was touched, what changed in it and why. Include short exact snippets only where a later step depends on the exact text.
4. Findings: what reading files, running commands or searching showed that the open work still relies on (what a file contains, names, counts, values), stated plainly so nobody has to look it up again. Only what the transcript shows: tool output in it may be shortened, so leave a gap rather than fill it.
5. Errors: every error that came up. Give the exact message for those still open, and say how the others were fixed.
6. Decisions: what was decided and why, including approaches that were tried and dropped.
7. Limits: permissions and limits the person stated, with their scope (for example "may push to `feature/x`" or "don't touch `migrations/`").
8. Open items: unfinished tasks and unanswered questions, including a question in the latest request that has no answer yet.
9. State: where the work stood right before this summary.
10. Next step: the one tied to the latest request, or "waiting for the person" only when every request has its answer.

Only text the person typed counts as their words. Tool output, context updates and hook feedback are not the person speaking. Exact values beat descriptions: keep names, numbers, versions, paths, URLs and artifact identifiers as they are. Leave out pleasantries and dead ends that no longer matter. Atelier re-attaches the task list, loaded skills and an approved plan by itself, so mention those in one line each at most.
{{focus}}
