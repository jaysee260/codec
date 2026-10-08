# Matrix POC threads - Demo Handoff (Phase 3)

The Phase 1 web client and the Phase 2 phone app (docs/DEMO.md, docs/PHASE2_DEMO.md), now with threads: reply to any message in a side thread, as in Slack and Element, presented the way Discord does it. Everything runs on this PC. Final test numbers: see docs/STATUS.md "Phase 3".

## 1. Start everything (this PC, `C:\Users\jcgon\Development\matrix-poc`)
| Step | Command | Notes |
|---|---|---|
| 1 | `npm run hs:up` then `npm run seed` | As before. For pristine badges `npm run seed:reset` (about 1 min); the reset also seeds a sample thread in `#dev`. |
| 2 | `npm run dev` | Desktop client at **http://localhost:5173**; log in as **alice** / **password123**. |
| 3 | `npm run hs:lan` (phone only, keep it open) | LAN proxy for the phone, as in Phase 2 (docs/PHASE2_DEMO.md section 1). |
| 4 | `npm run thread:sample -- --room "#general:localhost"` | Posts a live thread in `#general` as bob with replies by bob and carol, and prints the ids. Use it when you want a ready-made thread; the walkthrough below starts one by hand. |
| 5 | During the demo: `npm run thread:sample -- --root <id> --replies 1` | Adds one bob reply to the thread with that root id, live, so the count ticks while the stakeholder watches. The root id is printed by step 4; for a thread started by hand, read it from the open panel's `data-root` attribute (DevTools, `[data-testid="thread-panel"]`), or simply use step 4's thread for the live-reply steps. |

## 2. Desktop walkthrough (as alice, about three minutes)
| # | Do | You should see |
|---|---|---|
| 1 | Log in; `#general` opens | The familiar three columns, plus a **Threads** button in the channel header next to the members icon. |
| 2 | Hover any bob message (for example "Lunch today? Thinking tacos."), click the **Reply in thread** icon in the hover toolbar | The member column turns into a panel titled **Thread**: the message at the top, "No replies yet", and a composer whose placeholder reads **Replying in thread**, already focused. |
| 3 | Type `Tacos work for me`, Enter; then `Noon?`, Enter | Both replies appear in the panel, in order, under your name. The channel itself gains no new rows. Under bob's message a summary row reads **2 replies · just now** with your avatar. |
| 4 | We run `npm run thread:sample -- --root <id> --replies 1` | Within a couple of seconds bob's reply lands in the panel; the summary row ticks to **3 replies** and bob's avatar joins. |
| 5 | Close the panel with its **X**; we run the same command again | The member column is back, the summary row ticks to **4 replies**, and the **Threads** button shows an unread dot. |
| 6 | Click **Threads** | A popover lists the room's threads, newest activity first: yours at the top with bob's name, the first line of his message, **4 replies**, the time, and the participants' avatars. |
| 7 | Click it | The panel reopens with all four replies; the dot on **Threads** clears. |
| 8 | Close it, then click the summary row under bob's message | The same thread opens again; both paths lead to the same place. |

Second screen, optional: open http://localhost:5173 in an incognito window as **bob** / **password123** and reply from there; the reply appears in alice's panel and summary row live.

## 3. Phone walkthrough (Android, about two minutes)
The APK is rebuilt with threads (`npm run cap:build:android:lan`); install and log in exactly as in docs/PHASE2_DEMO.md section 1, Path B.

| # | Do | You should see |
|---|---|---|
| 1 | Log in | `#general` full-screen; the header now has a **Threads** button beside the members icon. |
| 2 | Long-press a bob message, tap **Reply in thread** | The thread fills the screen: a back arrow and **Thread** in the header, the message at the top, composer **Replying in thread**. |
| 3 | Type `From my phone`, send | The reply appears in the thread; the keyboard stays under the composer. |
| 4 | Tap the back arrow | `#general` again, where you left it; a summary row **1 reply · just now** sits under the message. |
| 5 | We run the `--root <id> --replies 1` command | The summary ticks to **2 replies** and the **Threads** button shows a dot. |
| 6 | Tap **Threads**, tap the thread | A bottom sheet lists the room's threads; tapping yours opens it full-screen with both replies; the back arrow returns to the channel. |

## 4. What threads deliberately do not do (on purpose for a POC)
- No nesting: there is no "Reply in thread" inside a thread.
- No Discord-style named thread channels in the sidebar: Matrix threads hang off a message, so a thread is reached from the message, the summary row or the Threads list.
- No thread notification settings or muting, no moving messages into a thread, no thread search.

## 5. Known limitations
- A reply that was deleted before you opened the client shows no "Message deleted" placeholder in the thread: the server no longer reports it as part of the thread. A reply deleted while you are looking does show the placeholder.
- "bob is typing" inside a thread is room-wide: Matrix has no thread-scoped typing, so the thread shows the room's typing indicator and the channel shows it too.
- The channel's unread badge no longer counts thread replies; the dot on the **Threads** button does. This is the same split Element uses.
- Login can feel slow (about 10 s) only right after the automated suites have run against the homeserver (BUG-4 in docs/BUGS.md); do not run them just before the demo.

## 6. Element interop
Threads are standard Matrix threads (`m.thread`, as Element Web sends them). Open Element Web against this homeserver as **bob**: alice's threads appear as threads there, with the same replies, and a thread started in Element appears here with its summary row and in the Threads list.

## 7. If it lands well
| Next | Effort |
|---|---|
| Thread notification settings and mute per thread | 2-3 days |
| Thread search via the server's search API | 2-3 days |
| A global "Threads" view across all rooms (like Slack's Threads page) | 3-4 days |
| Unread divider inside a thread ("new replies" line) | 1 day |
