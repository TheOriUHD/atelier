# What's new: clips

Short, silent clips that show a larger feature off in the What's new dialog (`media` on a highlight in
`../release-notes.ts`). They are bundled with the app: opening the dialog sends no request anywhere.

- **Format:** H.264 MP4, 1280×800 (16:10), 30 fps, no sound, under about 1 MB, with a JPEG poster (its last frame,
  shown before it plays and when motion is reduced). A GIF, WebP or PNG works too, without a poster.
- **Recorded from the real apps on throwaway data**, never from someone's own computer, with the scripted demo model
  (`apps/site/shots/demo-model.mjs`), so a clip can be made again after the interface changes.
- `atelier-cli.mp4` (0.6.0): `pnpm --filter @atelier/cli build && npx tsx apps/cli/scripts/record-clip.ts`. It records a
  session of the built terminal app in a real pseudo-terminal, then plays it back in xterm.js frame by frame.
