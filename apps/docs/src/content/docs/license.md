---
title: License
description: Atelier is source-available under the PolyForm Noncommercial License 1.0.0; this page explains it in plain words and says where the full text is.
---

Atelier is **source-available** under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/). You can read, run,
change and share the code for noncommercial purposes. It is not open source: commercial use is not covered.

:::caution
This page is a plain-words guide, **not legal advice**. The license text governs; if it does not settle your case,
ask a lawyer or the author.
:::

## Where the license is

* The `LICENSE` file at the top of the repository: the license text, preceded by one required notice line:
  `Required Notice: Copyright 2026 TheOriUHD (https://github.com/TheOriUHD/atelier)`.
* The `license` field of the root `package.json` and of the packages under `packages/` and `apps/`, as the identifier
  `PolyForm-Noncommercial-1.0.0`. (The `design` package has none.)
* The Windows installer, which shows the license text on its license step.

## In plain words

The license lets you use the software **for any noncommercial purpose**, and spells out what counts:

* **Personal use**: research, experiment and testing for the benefit of public knowledge, personal study, private
  entertainment, hobby projects, amateur pursuits and religious observance, without any anticipated commercial
  application.
* **Noncommercial organizations**: charitable organizations, educational institutions, public research organizations,
  public safety or health organizations, environmental protection organizations and government institutions, regardless
  of how they are funded.

Within a permitted purpose, the license lets you:

* **Use, copy and change** the software, and build new works on it.
* **Distribute** copies, including changed ones. If you do, everyone who receives a copy from you must also get the
  license terms (or their URL) and a copy of every `Required Notice:` line that came with the software.

Other terms worth knowing:

* **No sublicensing.** You cannot pass your permissions on; the author can still license the software to anyone.
* **Patents.** The author grants you a patent license for the software. If you make a written claim that the software
  infringes a patent, that license ends immediately.
* **Mistakes can be fixed.** The first time you are told in writing that you broke the terms, your licenses can
  continue if you come into full compliance and correct past violations within 32 days of receiving the notice.
  Otherwise they end.
* **No warranty.** As far as the law allows, the software comes as is, and the author is not liable for damages.
* **Fair use** and other rights you have under the law are not limited.

The license does not define "commercial"; it lists what is permitted. Whether a particular use, such as use inside a
company, falls within a permitted purpose is for you to judge from the text, or to ask about.

## Commercial use

Commercial use needs a separate license from the author: write to
[licensing@atelierhq.dev](mailto:licensing@atelierhq.dev) with who you are and how you want to use Atelier. Anything else
goes to [contact@atelierhq.dev](mailto:contact@atelierhq.dev).

## Third-party software

Atelier is built on other people's software, each part under its own license. Their licenses and copyright notices
are collected in
[`THIRD_PARTY_NOTICES.md`](https://github.com/TheOriUHD/atelier/blob/main/THIRD_PARTY_NOTICES.md), which ships with what
you install:

* **The desktop app:** `THIRD_PARTY_NOTICES.md` in the app's resources folder (on macOS, inside `Atelier.app` under
  `Contents/Resources`), with Electron's and Chromium's own license files (`LICENSE.electron.txt`,
  `LICENSES.chromium.html`).
* **The server image:** `/app/THIRD_PARTY_NOTICES.md` and `/app/LICENSE`.
* **The setup program:** `atelier-setup licenses` prints the licenses of the code it contains.
* **Fonts:** the interface bundles Inter, Source Serif 4, JetBrains Mono and OpenDyslexic, under the SIL Open Font
  License 1.1; the website and these docs serve the first three with their license (`/fonts/OFL.txt`).

The file is generated from the installed dependencies by `pnpm notices`, and a release is refused while it is out of
date.

The license above covers Atelier's own code. It does not change the terms of any of these.

## Services Atelier connects to

Model providers, search engines, GitHub and the other services Atelier connects to are named because Atelier works
with them. Their models and services are under their own terms, which apply to your use of them: your API key, your
ChatGPT or GitHub Copilot plan, your account. Some integrations are unofficial (a ChatGPT plan, ChatGPT Chat, GitHub
Copilot); the provider can change or restrict them, and Atelier cannot promise they keep working. See
[Providers](/providers/) and [ChatGPT](/chatgpt/).

## Names and trademarks

Atelier is an independent project, not affiliated with or endorsed by
Anthropic, OpenAI, GitHub or any other provider or service it connects to. Claude is a trademark of Anthropic. Other
product names belong to their owners and are used only to say what Atelier works with.

The license grants copyright and patent licenses to the software and says it implies no other licenses.

## Contributions

The license text says nothing about contributions, so the project's terms are in
[`CONTRIBUTING.md`](https://github.com/TheOriUHD/atelier/blob/main/CONTRIBUTING.md): a contribution is licensed under the
same license, and the maintainer may also license it under other terms, including commercial ones. Read it before you send
a change.
