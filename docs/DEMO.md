# Matrix POC - Demo Handoff

A Discord-style chat client on an open standard (Matrix), running entirely on this machine. Everything below takes about five minutes to set up and two minutes to walk through.

## 1. Start everything (this machine)
Run from `C:\Users\jcgon\Development\matrix-poc` in Git Bash or PowerShell. Node 24 is installed.

| Step | Command | Notes |
|---|---|---|
| 1 | `npm run hs:up` | Starts the Synapse homeserver on http://localhost:8008. Docker Desktop cannot run here (CPU virtualization is disabled in BIOS), so this automatically falls back to Synapse installed natively in the WSL1 distro `matrix-hs`. Takes 10-30 s; prints when it answers. |
| 2 | `npm run seed` | Creates the demo users, spaces, channels and history. Prints `already seeded` and exits if the data is there. For a pristine demo (unread badges at their seeded values, history untouched) use `npm run seed:reset` instead: wipes and reseeds in ~1 min. |
| 3 | `npm run dev` | Web app on http://localhost:5173 (leave this terminal open). |
| 4 | Open http://localhost:5173 | Log in as **alice** / **password123**. |
| 5 | Second window: incognito/private | Log in as **bob** / **password123**, click the top icon in the left rail ("Direct Messages"), open the **Alice Park** DM. This is your "other person" for step 9. |

Shutdown: `npm run hs:down`. Check health any time: `node scripts/hs.mjs status`.

## 2. The two-minute walkthrough (as alice)
| # | Do | You should see |
|---|---|---|
| 1 | Log in | The three-column layout in well under 3 s. Left rail: Home, **Acme HQ**, **Gaming**. Acme HQ is selected and `#general` is open. |
| 2 | Look at the channel list | `#general`, `#random` with an unread badge **3**, `#dev`. The Gaming icon has an unread dot. Member list on the right shows the four people in the room. |
| 3 | Scroll up through `#general` | About 40 messages grouped by sender, Discord-style. A **bold** reminder, a code block, a clickable link, an image, a reply with a quote, a 👍 x2 reaction pill, an "(edited)" marker. Older messages load as you reach the top, ending in "This is the beginning of #general". |
| 4 | Type `Hello from the demo`, press Enter | Appears instantly under your name. Shift+Enter inserts a newline without sending. |
| 5 | Hover bob's "Lunch today? Thinking tacos.", click the smiley-plus ("Add reaction"), pick 🎉 | A 🎉 pill appears on the message, highlighted because it is yours. Click it again to remove it. |
| 6 | Hover carol's "Will there be snacks?", click Reply, type `Yes`, Enter | The composer shows "Replying to Carol Nguyen"; your message renders with her text quoted above it. |
| 7 | Click the **+** at the left of the composer ("Upload a file"), choose any PNG or JPG | The image appears inline in the conversation. |
| 8 | Click `#random` | The badge clears and stays cleared if you reload. Reading a room marks it read. |
| 9 | Click **Home**, then **Bob Ruiz**. In the bob window, start typing, then send `On my way` | "Bob Ruiz is typing..." above the composer, then his message arrives live. No refresh. |
| 10 | Click **Gaming**, press **+** next to Text Channels, create `memes`. Then open the space menu (click "Gaming" at the top of the channel list), choose Invite, enter `@carol:localhost` | `#memes` appears and opens. Carol shows up under Invited in the member list. |

Users available for any ad-hoc poking: alice (admin), bob (moderator), carol, dave; all with password `password123`.

## 3. What this POC deliberately does not do
Voice/video · end-to-end encryption (all rooms are unencrypted on purpose) · push notifications · mobile or narrow layouts · federation with other servers · threads · single sign-on · message search · pins · role/permission editing · custom emoji · profile editing · presence (online/offline) dots.

## 4. Known issues
| Issue | Impact | Status |
|---|---|---|
| BUG-1: when older history loads at the top of a channel, the view can jump by about one screen instead of staying on the message you were reading | Cosmetic-to-annoying during step 3; nothing is lost | Fix is written and being verified; not yet committed |
| Timestamps on seeded history are the seeding time, not spread over days | History all reads as "today" | Synapse limitation for non-bot users; accepted for the POC |
| The automated end-to-end suite (96 Playwright checks) has so far only been run on a used database, where 7 checks skip by design because they need untouched seed data (one more is manual-only) | Confidence, not function | Run `npm run test:e2e:fresh` (reset + seed + suite, ~5 min) for the full green run |

## 5. If it lands well: what we would do next
Rough effort for one experienced engineer, in order of stakeholder value.

| Feature | Approach | Effort |
|---|---|---|
| Presence (online/idle/offline dots, status text) | Synapse presence is already on; wire `m.presence` into the member list and DM list | 2-3 days |
| Threads | Matrix threads (`m.thread` relations), a right-hand thread panel like Discord's | 1-2 weeks |
| Message search | Synapse server-side search API for unencrypted rooms; a search box in the header | 3-5 days |
| End-to-end encryption | matrix-js-sdk Rust crypto (WASM), device verification, key backup, encrypted media | 3-4 weeks |
| Push notifications | Web push via a service worker plus a Sygnal push gateway; desktop notifications first | 1-2 weeks |
| Voice / video channels | MatrixRTC with a LiveKit SFU (the stack Element Call uses): LiveKit server + JWT service in the homeserver stack, call UI in the client | 4-6 weeks |
| Mobile apps | Native iOS/Android on matrix-rust-sdk (shared Rust core, Swift/Kotlin UI), reusing this client's room and message model | 8-12 weeks per platform |
| Production hardening | Postgres instead of SQLite, TLS and a real domain, closed registration with invites, backups, monitoring | 1-2 weeks |
