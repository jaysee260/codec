# Seed Dataset (fixture contract)

Everything below is created by `npm run seed` against http://localhost:8008 (server_name `localhost`). Devs, QA and the demo all code against exactly this. `npm run seed:reset` wipes the Synapse volume and reseeds.

## Users
| Local part | User ID | Password | Display name | Notes |
|---|---|---|---|---|
| alice | `@alice:localhost` | `password123` | Alice Park | Demo driver. Admin (100) everywhere. |
| bob | `@bob:localhost` | `password123` | Bob Ruiz | Moderator (50) everywhere. Second live user in demo. |
| carol | `@carol:localhost` | `password123` | Carol Nguyen | Member (0). Not in #dev, not in Gaming. |
| dave | `@dave:localhost` | `password123` | Dave Okafor | Member (0). In everything. |

Avatars: optional. If set, upload `seed/assets/avatar-{name}.png` (64x64 solid colour with initial) and set `avatar_url` on the profile.

## Spaces and rooms
All rooms: `preset: public_chat`, `join_rule: public`, `history_visibility: shared`, **no** `m.room.encryption`. Space rooms have `creation_content: { type: "m.space" }`. Each channel gets an `m.space.child` state event in its space (`via: ["localhost"]`, `order` as below) and an `m.space.parent` state event (`canonical: true`) pointing at the space.

| Kind | Name | Alias | Topic | Members | `order` |
|---|---|---|---|---|---|
| Space | Acme HQ | `#acme-hq:localhost` | Everything Acme | alice, bob, carol, dave | - |
| Channel | general | `#general:localhost` | Company-wide chat. Be nice. | alice, bob, carol, dave | `01` |
| Channel | random | `#random:localhost` | Off-topic, memes, lunch plans. | alice, bob, carol, dave | `02` |
| Channel | dev | `#dev:localhost` | Engineering talk. Stack traces welcome. | alice, bob, dave | `03` |
| Space | Gaming | `#gaming:localhost` | After-hours squad | alice, bob, dave | - |
| Channel | lobby | `#lobby:localhost` | Find a squad. | alice, bob, dave | `01` |

Room `name` is the bare word (`general`); the UI adds `#`. Space avatars optional.

## Power levels (every space and channel)
| User | Level |
|---|---|
| alice | 100 |
| bob | 50 |
| carol, dave | 0 (default) |

Other power-level fields untouched (`events_default: 0`, `redact: 50`, `kick/ban: 50`, `invite: 0`).

## Direct messages
Created by alice with `is_direct: true`, `preset: trusted_private_chat`, `invite: [other]`; the other user joins. Seed sets `m.direct` account data on **both** users (`{ "@bob:localhost": ["!dmRoomId"] }` etc.). The DM list is driven by `m.direct`, not by membership.

| DM | Messages (in order) |
|---|---|
| alice <-> bob | bob: "Hey, got a sec?" / alice: "Sure, what's up?" / bob: "Can you review my PR before the demo?" / alice: "On it. Link?" / bob: "https://github.com/acme/chat/pull/42" / alice: "Looks good, left two comments." |
| alice <-> carol | carol: "Are you joining the planning meeting?" / alice: "Yes, I'll be there." / carol: "Great, I'll add you to the invite." / alice: "Thanks!" |

## #general - 40 messages (send in this order)
Plain `m.text` unless noted. Formatted rows send `format: "org.matrix.custom.html"` with `formatted_body` as given and the plain-text `body` shown.

| # | Sender | Body | Notes |
|---|---|---|---|
| 1 | alice | Welcome to Acme HQ! 🎉 This is our new home for company chat. | Reactions 🎉 from bob, carol, dave |
| 2 | alice | A few ground rules: #general for announcements, #random for everything else. | |
| 3 | bob | Hey everyone 👋 | |
| 4 | carol | Hi! Excited to be here. | |
| 5 | dave | o/ | |
| 6 | bob | Is this replacing email for internal stuff? | |
| 7 | alice | Mostly, yes. Long-form docs still go in the wiki. | **Reply** to #6 (`m.relates_to.m.in_reply_to`) |
| 8 | carol | Reminder: the Q4 planning meeting is Thursday at 10am. | **Bold** HTML: `Reminder: the <strong>Q4 planning meeting</strong> is Thursday at 10am.` |
| 9 | dave | Will it be recorded? | |
| 10 | carol | Yes, recording goes in the shared drive afterwards. | |
| 11 | bob | Lunch today? Thinking tacos. | Reactions 👍 from alice, carol |
| 12 | alice | Tacos works. Noon? | |
| 13 | bob | Noon it is. | |
| 14 | dave | PSA: the VPN cert rotates tonight, you may need to reconnect tomorrow morning. | Reaction 👀 from bob |
| 15 | carol | Thanks for the heads up | |
| 16 | alice | Here's the new logo draft: | |
| 17 | alice | acme-logo.png | **Image** `m.image`: upload `seed/assets/acme-logo.png` (256x256 PNG; seed generates it if missing), `info: { w: 256, h: 256, mimetype: "image/png", size }` |
| 18 | bob | Looks great. Love the colors. | **Edited**: original body `Looks grate. Love the colors.`, then an `m.replace` event with `m.new_content` = corrected text and fallback body `* Looks great. Love the colors.` |
| 19 | carol | Can we get it as an SVG too? | |
| 20 | alice | Sure, I'll post it in #dev later. | |
| 21 | dave | Anyone else seeing slow builds this morning? | |
| 22 | bob | Yeah, CI is backed up. Check https://status.example.com | **Link** HTML: `Yeah, CI is backed up. Check <a href="https://status.example.com">https://status.example.com</a>` |
| 23 | dave | Thanks | |
| 24 | carol | New hire starting Monday: please say hi to Erin when she joins! | |
| 25 | alice | Welcome in advance, Erin 👋 | |
| 26 | bob | Quick one: how do I mention someone here? | |
| 27 | alice | Type @ and start typing their name. | |
| 28 | bob | carol test 😄 | **Mention** HTML: `<a href="https://matrix.to/#/@carol:localhost">carol</a> test 😄`, plus `m.mentions: { user_ids: ["@carol:localhost"] }` |
| 29 | carol | It works 🙂 | |
| 30 | dave | Snippet for the curious, our deploy command: | |
| 31 | dave | npm run build && npm run deploy -- --env=prod | **Code block** HTML: `<pre><code class="language-bash">npm run build &amp;&amp; npm run deploy -- --env=prod</code></pre>` |
| 32 | alice | Don't run that from your laptop please 😅 | |
| 33 | bob | Friday demo is at 3pm. Agenda: 1) new chat client 2) Q4 roadmap 3) AOB | |
| 34 | carol | Will there be snacks? | |
| 35 | bob | There will be snacks. | **Reply** to #34 |
| 36 | dave | 🍩 | |
| 37 | alice | Reminder to fill in your timesheets before EOD. | |
| 38 | carol | Done ✅ | |
| 39 | dave | Done | |
| 40 | bob | Done. Have a good weekend all! | |

Then: alice sends an `m.read` receipt for #40.

## #random - 8 messages
| # | Sender | Body |
|---|---|---|
| 1 | bob | Best pizza place near the office? Go. |
| 2 | carol | Luigi's, no contest. |
| 3 | dave | Luigi's is overrated. Mario's. |
| 4 | alice | You two settle this over lunch. |
| 5 | bob | Settled: we're getting both. |
| - | **alice sends `m.read` receipt for #5 here** | |
| 6 | carol | Anyone want to do a board game night Thursday? |
| 7 | dave | In. |
| 8 | bob | In, if there are snacks. |

## #dev - 6 messages (alice, bob, dave)
| # | Sender | Body |
|---|---|---|
| 1 | dave | Build is green again. |
| 2 | bob | 🙌 |
| 3 | alice | SVG logo is in the design repo under /brand. |
| 4 | dave | Bumping Node to 24 in CI this week, shout if that breaks anything. |
| 5 | bob | Should be fine, we're already on 24 locally. |
| 6 | alice | Ship it. |

Then: alice sends an `m.read` receipt for #6.

## #lobby - 4 messages (Gaming)
| # | Sender | Body |
|---|---|---|
| 1 | dave | Who's up for some co-op tonight? |
| 2 | bob | Me, after 8. |
| - | **alice sends `m.read` receipt for #2 here** | |
| 3 | dave | 8 works. |
| 4 | dave | Voice is still on the other app... until this thing gets voice 😉 |

DMs: alice sends `m.read` for the last message in both DMs.

## Expected state when alice logs in
| Room | Unread for alice | Why |
|---|---|---|
| #general, #dev, both DMs | 0 | receipt on last event |
| #random | 3 | messages 6-8 after receipt |
| #lobby | 2 | messages 3-4 after receipt; Gaming rail icon shows unread dot |

Reaction pills in #general: #1 🎉 x3, #11 👍 x2 (includes alice's own, so highlighted), #14 👀 x1. Edited marker on #18. Reply quotes on #7 and #35. Image on #17. Timestamps are seed-time (Synapse ignores `ts` for non-appservice users); acceptable for the POC.

## Seed script requirements (Principal)
1. Location `seed/seed.ts`, run with `npm run seed`; raw `fetch` against `/_matrix/client/v3` (matrix-js-sdk not required).
2. Registers users via `POST /register` (open registration, `m.login.dummy`), logs in each user; every event is sent as its listed sender.
3. Idempotent guard: if `#acme-hq:localhost` already resolves, print `already seeded - run npm run seed:reset` and exit 0.
4. Sequential sends; retry on 429 honouring `retry_after_ms`. Homeserver `rc_*` limits are raised (see PLAN risks) so this should be rare.
5. Writes `seed/seed-output.json` (gitignored) for QA, shape: `{ users: { alice: "@alice:localhost", ... }, rooms: { "acme-hq", general, random, dev, gaming, lobby, "dm-alice-bob", "dm-alice-carol" }, events: { "general.first" (#1), "general.last" (#40), "general.replyTarget" (#6), "general.reply" (#7), "general.bold" (#8), "general.reacted" (#11), "general.image" (#17), "general.edited" (#18), "general.link" (#22), "general.mention" (#28), "general.code" (#31) } }` where every value is the room ID / event ID string.
6. Reaction keys must come from the client's hardcoded picker set: `👍 ❤️ 😂 🎉 🔥 👀`.
