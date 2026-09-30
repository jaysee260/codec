# Acceptance Criteria and Test ID Contract

Every criterion is testable by Playwright against the seed in `docs/SEED_DATA.md`, logged in as alice unless stated. Numbering `AC-<ticket>-<n>`. Tickets in `docs/TICKETS.md` reference these.

## Test ID conventions
1. Attribute is `data-testid`; Playwright uses `page.getByTestId(...)` (exact match).
2. kebab-case, `{area}-{element}`; dynamic suffix is the **raw Matrix ID**, never sanitised: `channel-item-!abc:localhost`, `message-$xyz`, `member-item-@bob:localhost`, `reaction-👍`.
3. Static IDs are unique per page; dynamic IDs are unique per list. Scope reactions and actions inside their `message-{eventId}`.
4. Helper attributes (not testids) let QA find seeded things without knowing IDs: `data-name` on space/channel/DM items (room name, e.g. `general`, `Acme HQ`, `Bob Ruiz`), `data-sender` on messages (user ID), `data-count` on unread badges and reaction pills, `data-mine="true|false"` on reaction pills, `data-selected="true|false"` on rail/list items.
5. Dialogs are rendered in a portal with the listed testids; `dialog-close` is shared by every dialog.
6. QA locates new (unseeded) messages by `getByTestId('message-list').getByText(...)`, seeded ones by event ID from `seed/seed-output.json`.

## Test ID registry
### Shell (Principal-owned, `src/app/**`)
| testid | Element |
|---|---|
| `login-form`, `login-username`, `login-password`, `login-submit`, `login-error` | Login page |
| `app-loading` | Full-screen loading state until sync is PREPARED |
| `app-shell` | Three-column layout root, only rendered when ready |
| `current-user`, `logout-button` | Bottom-left user pill + logout |
| `toast` | Global error/info toast |

### Navigation (Dev A, `src/features/navigation/**`)
| testid | Element |
|---|---|
| `space-rail`, `space-item-home`, `space-item-{spaceId}`, `space-unread-{spaceId}`, `space-add` | Rail, Home (DMs) button, one item per joined space, unread dot, create-space button |
| `channel-sidebar`, `space-header`, `space-header-name`, `space-menu`, `space-menu-invite`, `space-menu-create-channel` | Column 2 header + dropdown |
| `channel-list`, `channel-item-{roomId}`, `channel-unread-{roomId}`, `channel-add` | Channel list, items, unread badge (numeric), "+" button |
| `dm-list`, `dm-item-{roomId}`, `dm-unread-{roomId}`, `dm-new` | DM list (shown when Home selected), items, badge, "+" |
| `channel-header`, `channel-header-name`, `channel-header-topic`, `member-toggle` | Column 3 top bar |
| `member-list`, `member-section-{online|offline|invited}`, `member-item-{userId}`, `member-count` | Member panel |
| `create-channel-dialog`, `create-channel-name`, `create-channel-topic`, `create-channel-submit` | Create channel |
| `create-space-dialog`, `create-space-name`, `create-space-submit` | Create space |
| `invite-dialog`, `invite-user-id`, `invite-submit`, `invite-error` | Invite to space |
| `new-dm-dialog`, `new-dm-user-id`, `new-dm-submit` | Start DM |
| `dialog-close` | Close/cancel in any dialog |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `message-list`, `timeline-start`, `timeline-loading` | Scroll container; "beginning of #x" banner; top spinner during pagination |
| `day-divider` | Date separator |
| `message-{eventId}` (+`data-sender`), `message-group-start` | Message row; attribute on rows that begin a sender group (avatar + name shown) |
| `message-avatar`, `message-author`, `message-timestamp`, `message-body` | Inside a row |
| `message-edited`, `message-redacted`, `message-image`, `message-mention` | "(edited)" marker; deleted placeholder; `<img>`; mention pill in body |
| `message-reply-quote`, `message-reply-quote-author` | Quote block above a reply |
| `message-reactions`, `reaction-{key}` (+`data-count`, `data-mine`), `reaction-add` | Pill row, pill, "add reaction" button in the row |
| `message-actions`, `message-action-react`, `message-action-reply`, `message-action-edit`, `message-action-delete` | Hover toolbar (edit/delete only on own or mod-able messages) |
| `reaction-picker`, `reaction-picker-{key}` | Picker popover and its 6 options |
| `delete-dialog`, `delete-confirm` | Delete confirmation |
| `typing-indicator` | "bob is typing..." bar above composer |
| `composer`, `composer-input`, `composer-send`, `composer-attach`, `composer-file-input` | Textarea, send button, paperclip, hidden `<input type=file>` |
| `composer-reply-banner`, `composer-reply-cancel`, `composer-edit-banner`, `composer-edit-cancel` | Reply/edit state banners |
| `upload-progress` | Progress bar while uploading |
| `mention-autocomplete`, `mention-option-{userId}` | Popup and options |

## Criteria

### Shell (Principal) - referenced by QA-1
| ID | Given / When / Then |
|---|---|
| AC-SH-1 | Given logged out, when I open `/`, then `login-form` is visible and `app-shell` is not. |
| AC-SH-2 | Given the login form, when I submit `alice`/`password123`, then `app-loading` shows, then `app-shell` is visible within 10 s and `current-user` contains `Alice Park`. |
| AC-SH-3 | Given wrong password, when I submit, then `login-error` is visible and I stay on the form. |
| AC-SH-4 | Given logged in, when I reload, then `app-shell` reappears without the login form (session persisted). |
| AC-SH-5 | Given logged in, when I click `logout-button`, then `login-form` is visible and localStorage holds no token. |

### DEV-A-1 Space rail
| ID | Given / When / Then |
|---|---|
| AC-A1-1 | Given alice is logged in, when the shell renders, then `space-rail` shows `space-item-home` then items with `data-name` `Acme HQ` and `Gaming`, in that order. |
| AC-A1-2 | Given the shell just loaded, then the Acme HQ item has `data-selected="true"` and `channel-list` shows Acme channels. |
| AC-A1-3 | When I click the Gaming item, then it becomes selected, `space-header-name` reads `Gaming`, and `channel-list` contains only `lobby`. |
| AC-A1-4 | When I click `space-item-home`, then `dm-list` is visible and `channel-list` is not. |
| AC-A1-5 | Given a space item, when hovered, then a tooltip with the space name is shown (visual; QA checks `title` attribute equals name). |

### DEV-A-2 Channel list and header
| ID | Given / When / Then |
|---|---|
| AC-A2-1 | Given Acme HQ selected, then `channel-list` items are `general`, `random`, `dev` in `m.space.child` order, each prefixed with `#`. |
| AC-A2-2 | Given the shell just loaded, then the first channel (`general`) is selected and `channel-header-name` reads `general`, `channel-header-topic` reads `Company-wide chat. Be nice.`. |
| AC-A2-3 | When I click the `random` item, then it gets `data-selected="true"`, `channel-header-name` reads `random`, and `message-list` contains `Best pizza place near the office? Go.` within 1 s. |
| AC-A2-4 | When I switch space and back, then the last selected channel of that space is restored. |
| AC-A2-5 | Given a selected channel, when I reload, then the same space and channel are selected (persisted in localStorage). |

### DEV-A-3 DM list
| ID | Given / When / Then |
|---|---|
| AC-A3-1 | Given Home selected, then `dm-list` shows items with `data-name` `Bob Ruiz` and `Carol Nguyen` (from `m.direct`) with avatars/initials. |
| AC-A3-2 | When I click the Bob item, then `channel-header-name` reads `Bob Ruiz` and `message-list` contains `Hey, got a sec?`. |
| AC-A3-3 | Given a DM is open, then `member-list` is hidden or shows only the two participants. |

### DEV-A-4 Member list
| ID | Given / When / Then |
|---|---|
| AC-A4-1 | Given `general` open, then `member-list` lists `member-item-@alice:localhost`, bob, carol, dave with display names, and `member-count` reads `4`. |
| AC-A4-2 | Given `dev` open, then carol is absent and `member-count` reads `3`. |
| AC-A4-3 | When I click `member-toggle`, then `member-list` hides; click again shows it. |
| AC-A4-4 | Given a user is invited but not joined, then they appear under `member-section-invited`. |

### DEV-A-5 Unread badges
| ID | Given / When / Then |
|---|---|
| AC-A5-1 | Given fresh seed, then `channel-unread-{random}` shows `3` (`data-count="3"`) and `general`/`dev` have no badge. |
| AC-A5-2 | Given fresh seed, then `space-unread-{gaming}` is visible and `space-unread-{acme}` is visible (random unread); after reading random, the Acme dot disappears. |
| AC-A5-3 | When I open `random`, then its badge disappears within 2 s and stays gone after reload. |
| AC-A5-4 | Given `general` open, when bob posts in `random` via API, then `channel-unread-{random}` appears with `1` without reload. |
| AC-A5-5 | Given Home selected, when bob posts in the DM via API, then `dm-unread-{dm}` shows `1`; opening the DM clears it. |

### DEV-A-6 Create channel
| ID | Given / When / Then |
|---|---|
| AC-A6-1 | Given Gaming selected, when I click `channel-add`, then `create-channel-dialog` opens with focus in `create-channel-name`. |
| AC-A6-2 | When I enter `memes`, topic `Only the dankest`, and submit, then the dialog closes, `channel-list` contains `memes`, and it is selected with topic shown. |
| AC-A6-3 | Given the new channel, when bob syncs (API: room hierarchy of Gaming), then `memes` is a child of Gaming, public, unencrypted. |
| AC-A6-4 | When I submit an empty name, then `create-channel-submit` is disabled. |

### DEV-A-7 Invite user
| ID | Given / When / Then |
|---|---|
| AC-A7-1 | Given Gaming selected, when I open `space-menu` and click `space-menu-invite`, then `invite-dialog` opens. |
| AC-A7-2 | When I enter `@carol:localhost` and submit, then the dialog closes and carol appears under `member-section-invited` for the space's channels within 2 s. |
| AC-A7-3 | When I enter an unknown user `@nobody:localhost`, then `invite-error` shows the server error and the dialog stays open. |

### DEV-A-8 Create space
| ID | Given / When / Then |
|---|---|
| AC-A8-1 | When I click `space-add`, enter `Design`, and submit, then a rail item with `data-name="Design"` appears, is selected, and `channel-list` shows one auto-created `general` channel. |

### DEV-A-9 New DM
| ID | Given / When / Then |
|---|---|
| AC-A9-1 | Given Home selected, when I click `dm-new`, enter `@dave:localhost`, submit, then `dm-list` shows `Dave Okafor` and the DM opens; re-doing it reuses the same room. |

### DEV-B-1 Timeline rendering and grouping
| ID | Given / When / Then |
|---|---|
| AC-B1-1 | Given `general` open, then `message-list` shows the seeded messages oldest-to-newest, scrolled to the bottom, and `message-{general.last}` is visible. |
| AC-B1-2 | Given consecutive messages from one sender within 5 minutes, then only the first has `message-group-start` (avatar + `message-author` + `message-timestamp`); the rest have no avatar/author. |
| AC-B1-3 | Given messages #1-#2 (alice) then #3 (bob), then #3 starts a new group. |
| AC-B1-4 | Given the edited message #18, then `message-body` reads `Looks great. Love the colors.`, `message-edited` is present, and no separate `* Looks great...` row exists. |
| AC-B1-5 | Given reaction/edit events, then no `m.reaction` or `m.replace` event renders as its own row. |
| AC-B1-6 | Given a redacted message (QA redacts one via API), then that row shows `message-redacted` with text `Message deleted` and no body. |
| AC-B1-7 | Given the first message of the room is loaded, then at least one `day-divider` appears above it. |
| AC-B1-8 | Given `message-timestamp`, then it shows `HH:MM` for today and `DD/MM/YYYY HH:MM` otherwise; hover on a non-group-start row shows its time (visual). |

### DEV-B-2 Composer
| ID | Given / When / Then |
|---|---|
| AC-B2-1 | When I type `Hello from the demo` in `composer-input` and press Enter, then a row with that text and `data-sender="@alice:localhost"` appears within 2 s and the input is cleared. |
| AC-B2-2 | When I type `line one`, Shift+Enter, `line two`, then the input contains a newline and nothing was sent; Enter then sends a two-line message rendered with a line break. |
| AC-B2-3 | When I click `composer-send`, then the message is sent (same as Enter). |
| AC-B2-4 | Given empty or whitespace-only input, when I press Enter, then nothing is sent and `composer-send` is disabled. |
| AC-B2-5 | When I type, then a typing notification is sent (bob via API sees alice in `/sync` typing within 3 s); it stops within 5 s of stopping typing or immediately on send. |
| AC-B2-6 | Given the composer placeholder, then it reads `Message #general` / `Message @Bob Ruiz` per room. |

### DEV-B-3 Backwards pagination
| ID | Given / When / Then |
|---|---|
| AC-B3-1 | Given `general` just opened, then `message-{general.first}` is not in the DOM (initial window is ~30 events). |
| AC-B3-2 | When I scroll `message-list` to the top, then `timeline-loading` appears, older messages load, `message-{general.first}` becomes present, and the previously top-most message stays at the same viewport position (no jump). |
| AC-B3-3 | Given all history loaded, when I scroll to the top again, then `timeline-start` is visible reading `This is the beginning of #general` and no further requests occur. |
| AC-B3-4 | Given I am scrolled up reading history, when a new message arrives, then the view does not auto-scroll; when I am at the bottom, it does. |

### DEV-B-4 Formatted bodies and images
| ID | Given / When / Then |
|---|---|
| AC-B4-1 | Given message #8, then `message-body` contains a `<strong>` with `Q4 planning meeting`. |
| AC-B4-2 | Given message #31, then `message-body` contains `<pre><code>` with the deploy command, monospace, dark block. |
| AC-B4-3 | Given message #22, then `message-body` contains an `<a>` with `href="https://status.example.com"`, `target="_blank"`, `rel="noopener noreferrer"`. |
| AC-B4-4 | Given a message whose `formatted_body` is `<img src=x onerror=alert(1)><script>alert(2)</script>hi` (QA sends via API), then the rendered body contains `hi` and no `<script>`/`onerror` attribute. |
| AC-B4-5 | Given message #17, then `message-image` renders an `<img>` with an `http://localhost:8008/_matrix/...` thumbnail URL, max 400 px wide, and clicking opens the full-size media in a new tab or lightbox. |
| AC-B4-6 | Given a plain-text body containing a URL, then it is auto-linkified. |
| AC-B4-7 | Given message #28, then the mention renders as `message-mention` pill showing `@Carol Nguyen`, not the raw matrix.to URL. |

### DEV-B-5 Reactions
| ID | Given / When / Then |
|---|---|
| AC-B5-1 | Given message #1, then `message-reactions` shows `reaction-🎉` with `data-count="3"`, `data-mine="false"`; #11 shows `reaction-👍` count 2 `data-mine="true"` (highlighted). |
| AC-B5-2 | When I hover message #11 and click `message-action-react`, then `reaction-picker` opens with 6 `reaction-picker-{key}` options (👍 ❤️ 😂 🎉 🔥 👀). |
| AC-B5-3 | When I pick 🎉, then `reaction-🎉` appears on #11 with count 1 and `data-mine="true"` within 2 s (same action as demo step 5). |
| AC-B5-4 | When I click my own `reaction-🎉` pill, then it is removed (redacted) and disappears within 2 s; clicking a non-mine pill adds my reaction and increments the count. |
| AC-B5-5 | Given bob reacts 😂 to #11 via API, then `reaction-😂` appears live without reload. |
| AC-B5-6 | Given a pill, when hovered, then its `title` lists reactor display names. |

### DEV-B-6 Replies
| ID | Given / When / Then |
|---|---|
| AC-B6-1 | Given message #7, then it shows `message-reply-quote` with `message-reply-quote-author` `Bob Ruiz` and text `Is this replacing email for internal stuff?`. |
| AC-B6-2 | When I hover #34 and click `message-action-reply`, then `composer-reply-banner` reads `Replying to Carol Nguyen` and `composer-input` is focused. |
| AC-B6-3 | When I type `Yes` and press Enter, then the new row has a quote of #34 and the banner is gone; the event has `m.relates_to.m.in_reply_to.event_id` = #34 (QA checks via API). |
| AC-B6-4 | When I click `composer-reply-cancel` or press Escape in the composer, then the banner clears and the next send is a normal message. |
| AC-B6-5 | When I click a `message-reply-quote`, then the list scrolls to the quoted message and highlights it briefly. |

### DEV-B-7 Typing indicator and read receipts
| ID | Given / When / Then |
|---|---|
| AC-B7-1 | Given the bob DM open, when bob sends typing=true via API, then `typing-indicator` reads `Bob Ruiz is typing...` within 3 s; when typing=false, it disappears. |
| AC-B7-2 | Given two users typing, then it reads `Bob Ruiz and Dave Okafor are typing...`; never lists alice herself. |
| AC-B7-3 | Given `random` (3 unread) opened and scrolled to bottom, then an `m.read` receipt for the last event is sent within 2 s (QA checks via API as bob: alice's receipt on that event). |
| AC-B7-4 | Given a room is open and at the bottom, when a new message arrives, then a receipt for it is sent. |

### DEV-B-8 Upload
| ID | Given / When / Then |
|---|---|
| AC-B8-1 | When I click `composer-attach`, then `composer-file-input` opens (QA uses `setInputFiles`). |
| AC-B8-2 | When I select a PNG (`e2e/fixtures/test-image.png`), then `upload-progress` shows, then an `m.image` row appears with `message-image` within 5 s, with correct `info.w/h`. |
| AC-B8-3 | When I select a non-image file (`.txt`), then an `m.file` row renders as a download link with the filename. |
| AC-B8-4 | When I paste an image from the clipboard into `composer-input`, then it uploads as in AC-B8-2 (manual check; Playwright optional). |

### DEV-B-9 Edit and delete
| ID | Given / When / Then |
|---|---|
| AC-B9-1 | Given my own message, when I hover, then `message-action-edit` and `message-action-delete` are present; on bob's message (alice is admin) delete is present, edit is not; as carol (level 0) neither is present on others' messages. |
| AC-B9-2 | When I click edit, then `composer-edit-banner` shows, `composer-input` is prefilled with the body; Enter sends an `m.replace`; the row updates and shows `message-edited`. |
| AC-B9-3 | When I press ArrowUp in an empty composer, then edit mode opens on my last message. |
| AC-B9-4 | When I click delete and confirm in `delete-dialog` via `delete-confirm`, then the row becomes `message-redacted`. |

### DEV-B-10 Mention autocomplete
| ID | Given / When / Then |
|---|---|
| AC-B10-1 | When I type `@ca` in `composer-input`, then `mention-autocomplete` shows `mention-option-@carol:localhost` (filtered on display name and localpart, members of the current room only). |
| AC-B10-2 | When I press Enter or click the option, then the input shows `@Carol Nguyen ` and the sent event has `formatted_body` with a matrix.to link and `m.mentions.user_ids` including carol; the rendered row shows a `message-mention` pill. |
| AC-B10-3 | When I press Escape, then the popup closes without inserting. |
