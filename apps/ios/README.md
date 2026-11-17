# Atelier for iPhone and iPad

A native SwiftUI client for an Atelier server (iOS and iPadOS 26, Swift 6). It signs in over HTTPS and talks to the server's
JSON-RPC WebSocket, so everything the desktop and web apps do for a person's role is here: conversations, Code mode,
settings, and for admins the providers, models, users and server pages.

```sh
brew install xcodegen
cd apps/ios && xcodegen generate          # makes Atelier.xcodeproj from project.yml
open Atelier.xcodeproj                     # or build with xcodebuild
```

- `Sources/` the app. `Sources/Features/<Area>/` holds each area (Chat, Code, Personal, Customize, AdminModels, AdminServer);
  `Kit.swift` the shared building blocks, `SettingsHub.swift` the Settings structure with admin gating.
- `Tests/` unit tests and integration tests that run against a throwaway server (they skip without `TEST_RUNNER_ATELIER_TEST_*`).
- `scripts/live-server.mjs` starts a throwaway server with a scripted model and an HTTPS front for trying the app.
  `scripts/shot.sh` launches the app in a simulator with debug options and screenshots it. `scripts/install-on-device.sh`
  builds a signed Release app and installs it on a connected device. `scripts/build-lock.sh`, `mem-guard.sh`, `slot-enforcer.sh`
  and `disk-guard.sh` keep several people building at once from exhausting the Mac.
- Debug builds understand `--demo <screen>` (canned data, no server), `--open settings/<page>`, `--role admin|user`,
  `--autologin <address> <user> <password>` and a few per-area switches (see `Launch.swift` and the `*Demo.swift` files).

The app needs a server that supports the mobile client (`mobileProtocol: 1` in `/api/health`). Code sessions run on a computer
linked to the server (a desktop app or a runner), not on the phone.
