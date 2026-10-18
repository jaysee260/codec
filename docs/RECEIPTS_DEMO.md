# codec read receipts - Demo Handoff

The Phase 1-6 client (docs/DEMO.md through docs/PHASE6_PLAN.md), now with Element-style "sent / seen by": a check on your newest message until someone reads it, small avatars under the row each person has read up to, a Seen by / Not seen yet list per message, and a **Send read receipts** switch. Final test numbers: docs/STATUS.md "Read receipts".

## 1. The three things to know
1. **"Sent" means the server has it.** Matrix has no separate "delivered" state: a hollow circle while the message is on its way, a check once the homeserver accepted it, the usual red failed state if not. The check only ever sits on your **newest** message that nobody has read yet; the moment someone reads it, their avatar takes its place.
2. **Avatars sit at each person's read point and move.** Under a message you see the people whose latest read is exactly there (max 3, then "+N"). As they read on, their avatar moves down. Hover or click the avatars (tap on the phone), or use **Seen by** in the message actions, for the full list: **Seen by** with the time, and **Not seen yet**. In a quiet room, Seen by on an unread message is how you see who has not caught up.
3. **You can go private.** Settings > **Send read receipts** off: others stop seeing your avatar (you look like "not seen yet" to them), your own unread counts still clear, and you still see everyone else's receipts. The switch is shared with Element through your account, so flipping it in either client flips both.

## 2. Local walkthrough (two browsers, local server)
Prep by us: Synapse up, `npm run dev`, Chrome window 1 as **alice** / `password123`, window 2 (incognito) as **bob** / `password123`, both in `#dev`.

| # | JC does | They should see |
|---|---|---|
| 1 | Window 1 (alice): send "hello from codec" | A hollow circle at the right edge of the row for a moment, then a check. Hover it: "Sent". |
| 2 | Window 2 (bob): just look at `#dev` (it is open and at the bottom, so bob's client marks it read) | Window 1: the check on alice's message turns into **bob's avatar** under it, with no reload. |
| 3 | Window 1: hover the avatar | A small popover: **Seen by** Bob Ruiz with the time; **Not seen yet** Carol Nguyen, Dave Okafor. Click the avatar to pin it; Escape closes it. |
| 4 | Window 1: send two more messages, "two" and "three" | Only "three" has the check; bob's avatar is still under "hello from codec". |
| 5 | Window 2: scroll to the bottom (or just wait, bob is already pinned) | Window 1: bob's avatar jumps from "hello from codec" to "three", and the check disappears. The list did not jump. |
| 6 | Window 1: hover "two" (no avatar under it), click **Seen by** in the message toolbar | **Seen by** Bob Ruiz (his read point "three" covers "two": avatars mark only the latest read point, the list tells the whole truth) and **Not seen yet** Carol Nguyen, Dave Okafor. This is how you see who has not caught up on a message nobody is sitting on. |
| 7 | Window 2 (bob): click the user menu at the bottom left, turn **Send read receipts** off; window 1 (alice): send "four" | Window 2 shows "four" and bob's unread badge for `#dev` clears, but window 1 keeps the check on "four": bob's read is private. Turn it back on; bob's avatar appears under "four". |
| 8 | Window 1: open `#vault` (encrypted), send "secret" | Same hollow circle then check; window 2 opens `#vault`, window 1 shows bob's avatar under "secret". Receipts are plain metadata, so encryption changes nothing here. |
| 9 | Window 1 (alice): hover "secret", **Reply in thread**, send "in thread"; window 2 (bob): open the same thread | Window 1, inside the thread panel: the check on "in thread" turns into bob's avatar once his thread panel is open. The main timeline rows do not change: threads keep their own read points, separate from the main timeline. |

## 3. Phone walkthrough (Android device or the `mobile` project)
| # | JC does | They should see |
|---|---|---|
| 1 | Open `#dev`, send a message, let bob (laptop) read it | Hollow circle, check, then bob's avatar under the message. |
| 2 | Tap the avatar | A bottom sheet: Seen by / Not seen yet. Tap outside to close. |
| 3 | Long-press a message nobody read, tap **Seen by** | The same sheet with Nobody has seen this yet + the Not seen yet list. |
| 4 | Open the drawer, toggle **Send read receipts** | The switch is at least thumb-sized; the setting matches the laptop after a reload. |

## 4. Scripts
| Command | What it does |
|---|---|
| `npm run test:e2e:receipts` | `receipts` (desktop, two browser contexts) and `mobile-receipts` specs |
| `npm run test:unit` | Includes `src/lib/matrix/receipts.test.ts` (read points, hidden events, "+N", account-data merge) |
| `__matrixPoc.receipts.getReadPoints(roomId)` in DevTools | What the UI should show for every row in the open room |

## 5. Known limits
No "delivered to the other device" state (Matrix has none); avatars reflect each user's **latest** read point only (someone who read a message and then read a newer one shows under the newer one, but appears under Seen by on both); a user with private receipts is simply "not seen yet"; rooms above 50 members show a count instead of the Not seen yet names; the setting is global, not per room; no changes to the typing indicator or push.
