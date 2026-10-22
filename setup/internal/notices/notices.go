// Package notices holds the licenses of the third-party Go modules linked into atelier-setup. NOTICES.txt is written by
// `pnpm notices` (deploy/ship/notices.mjs); the release refuses to ship when it is out of date.
package notices

import _ "embed"

// Text is printed by `atelier-setup licenses`.
//
//go:embed NOTICES.txt
var Text string
