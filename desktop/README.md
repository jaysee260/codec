# Codec for Mac

A small Electron app that opens the live site (https://codec.704.chat) in its own window. Every deploy of the site
updates the app; the app itself only needs a rebuild when this folder changes.

What it adds over a browser tab:

- Dock icon with the unread count, and the same count next to the menu bar icon.
- macOS notifications for new messages (the room's notification settings apply; nothing for the room you are
  reading). Clicking one opens that room.
- Closing the window keeps Codec running in the Dock and menu bar, so it stays synced and calls still ring (the Dock
  icon bounces). Cmd+Q quits.
- Links in messages open in your default browser. Sign-in (Keycloak) stays in the app.
- View > Back to Codec (Cmd+Shift+H) if a sign-in page ever gets stuck.

The app is a new device: the first time, unlock your message history with your recovery key, as on any new browser.
It shows up as "Codec (Mac)" in your device list.

## Installing (testers)

1. Download `Codec-<version>-universal.dmg` (works on Intel and Apple Silicon) and drag Codec to Applications.
2. Open Codec. macOS says it can't check it for malware (the app is not signed with an Apple Developer ID). Click
   Done, then open System Settings > Privacy & Security, scroll down, and click **Open Anyway** next to Codec.
   This is needed once.
3. Sign in. Allow notifications and, the first time you record or call, the microphone.

## Building

- Every pull request that touches `desktop/` builds the app on GitHub (workflow "Mac app"); the .dmg is under the
  run's artifacts. "Run workflow" on the Actions tab does the same for master.
- Release for testers: push a tag `desktop-v<version>` (bump `version` in package.json first). The workflow publishes
  a GitHub release with the .dmg, which anyone can download.
- On a Mac: `npm install`, then `npm start` (live site), `npm run start:local` (a local `npm run dev` on :5173),
  `npm test` and `npm run test:launch`, `npm run dist` (writes `release/`).

## Signing later (optional)

With an Apple Developer account ($99/year) the "Open Anyway" step goes away: add the Developer ID certificate and
notarization credentials as repository secrets and pass them to the Build step (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). The hardened-runtime entitlements are already in
`build/entitlements.mac.plist`.
