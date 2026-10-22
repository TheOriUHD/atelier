# Security policy

## Reporting a vulnerability

Please report a suspected vulnerability **privately**, not in a public issue or discussion:

- On GitHub, open the repository's **Security** tab and choose **Report a vulnerability** (a private advisory only the
  maintainer can read).
- Or by email to [contact@atelierhq.dev](mailto:contact@atelierhq.dev), with "Security" in the subject.

Include what you found, the version (Settings › System shows it on the desktop app; `/api/health` on a server), how to
reproduce it, and what an attacker could do with it. A proof of concept helps; please don't test against someone else's
server.

Atelier is maintained by one person, so replies are best-effort. A confirmed problem is fixed in the next release, and the
fix is described in the changelog once people have had a chance to update. If you want to be credited, say so.

## What is in scope

The desktop app, the web server and its Docker images, the Go runner, and the update mechanism (the signature check, the
feeds). The [security page of the documentation](https://docs.atelierhq.dev/security/) describes the model and what Atelier
does not protect against; in particular:

- Auto permission mode reduces prompts, it is not a security boundary.
- A model provider you connect sees what you send it, and a model can be wrong or be steered by text it reads.
- ChatGPT Plan and ChatGPT Chat are unofficial ways to use a ChatGPT subscription and can change or stop working.

## Supported versions

The newest release. Older versions are not patched; the desktop app updates itself and the server image is updated with
`docker compose pull`.
