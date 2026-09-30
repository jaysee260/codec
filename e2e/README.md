# e2e

QA owns this folder (see `docs/TICKETS.md` QA-1). Specs are `*.spec.ts`, helpers live in `fixtures/`.

| File | Covers |
|---|---|
| `shell.spec.ts` | AC-SH-1 .. AC-SH-5 (login, session, logout) |
| `navigation.spec.ts` | AC-A1-1 .. AC-A9-1 (rail, channels, DMs, members, badges, create/invite) |
| `conversation.spec.ts` | AC-B1-1 .. AC-B10-3 (timeline, composer, pagination, rich bodies, reactions, replies, receipts, upload, edit/delete, mentions) |
| `smoke.spec.ts` | the `docs/PLAN.md` demo script, steps 1-10, serial, one screenshot per step into `results/demo/` |

## Running

```bash
npm run hs:up            # Synapse on http://localhost:8008
npm run seed             # writes seed/seed-output.json (room + event ids the fixtures read)
npm run test:e2e         # whole suite, Chromium, 1 worker
npm run test:e2e:smoke   # the demo script only
npm run test:e2e:fresh   # seed:reset + the whole suite  <-- the intended way to run it
npx playwright test e2e/conversation.spec.ts -g "AC-B4-2" --workers=1 --reporter=list
```

Artefacts: `e2e/results/<test>/` (trace, failure screenshot, video), `e2e/results/demo/` (the demo
screenshots, written even when green), `playwright-report/`.

**Do not run two suites at once.** Every invocation wipes `e2e/results/` on start and the config
reuses whatever dev server is on 5173, so a second run deletes the first run's traces mid-flight —
which shows up as a teardown failure like
`browserContext.close: ENOENT ... .playwright-artifacts-N/traces/...network` on a test that actually
passed. Copy a trace out of `e2e/results/` if it has to survive the next run, and note that
`--reporter=list` *replaces* the config reporters, so a `list`-only run leaves no HTML report either.

## The full suite is meant to run on a fresh seed

`npm run test:e2e:fresh` = `npm run seed:reset && npm run test:e2e`. **A green run of every criterion
is only defined on a pristine seed**, because two of the seeded preconditions are consumed by use and
cannot be put back on a live homeserver:

- **The initial sync window.** The client opens a room with roughly the last 30 events. Several
  criteria are about *which* seeded messages that window holds (AC-B1-1 "#40 is visible at the
  bottom", AC-B3-1 "#1 is not in the DOM"). Every message anybody sends into `#general` — a test, a
  dev poking at the UI, another agent — pushes the seeded messages further out of it.
- **Unread counts.** The seed leaves `#random` at 3 and `#lobby` at 2 for alice (`docs/SEED_DATA.md`).
  The first client that opens either room sends an `m.read` receipt, and Synapse will not move a
  receipt backwards, so the seeded number is gone for good.

Everything else is written to survive a dirty homeserver: seeded rows are located by event id from
`seed/seed-output.json` and paged back to when they have dropped out of the window, rows this run
creates are located by their unique text, unread counts are compared against the count derived from
receipts + timeline (`ApiUser.unreadFor`) rather than against a hard-coded 3, and the replayable
preconditions (`fixtures/state.ts`) top up unread and withdraw a leftover invite before the criteria
that need them. No spec asserts an exact message count.

### How the guard behaves on a dirty database

`fixtures/fresh.ts` exports `requireFreshSeed(test)`. It probes the homeserver once per worker and
caches the verdict for the rest of the run (the run itself dirties both signals, so re-probing later
would skip tests that should have run). The seed counts as pristine when **both** hold:

1. the newest event in `#general` is still the seeded last message (`events["general.last"]`), read
   with `GET /_matrix/client/v3/rooms/{general}/messages?dir=b&limit=1` as alice; and
2. alice's unread in `#random` is still 3.

When either fails, the calling test is skipped with the reason
`requires a fresh seed: run npm run test:e2e:fresh`, plus a `needs-fresh-seed` annotation naming
what drifted (e.g. `#general has events after the seeded last message (newest is $..., expected
$...)`). So on a dirty database you get **skips, not red criteria** — a skip says "not judgeable
here", a failure says "the product is wrong", and the two must not be confused in a bug report.

Guarded (they cannot be judged without a pristine seed):

- `conversation.spec.ts`: AC-B1-1, AC-B3-1;
- `navigation.spec.ts`: AC-A2-3 (it names `#random`'s *first* seeded message, and the criterion wants
  it on screen within a second of clicking the channel, so paging back is not an option);
- `smoke.spec.ts`: demo steps 2, 3, 5 and 6 (the demo script is written against a fresh seed; steps 5
  and 6 act on seeded rows that only the step-3 walk-back brings into the DOM). Steps 1, 4, 7, 8, 9
  and 10 are freshness-independent and still run.

Made freshness-independent instead of guarded, by paging the room back to the seeded row (the
criterion is about how the row *renders*, not about where the window ends): AC-B1-4, AC-B1-8,
AC-B4-2, AC-B6-2/AC-B6-3, AC-B6-4.

## Conventions

- Selectors come from the `data-testid` registry in `docs/ACCEPTANCE.md`; no CSS/text selectors for
  structure. Text is asserted on, or used to find *unseeded* messages, which the contract allows.
- **No `waitForTimeout`.** Waits are locator auto-waits, `expect.poll`, or waiting for a testid.
- A message this run sent renders first as a local echo (`message-~abc`) and is re-keyed to
  `message-$abc` when the remote echo arrives, which unmounts the echo node. Never read a row's id
  straight after it appears — use `settledEventId(row)` from `fixtures/ui.ts` before hovering it or
  looking it up through the API, or the row detaches mid-action.
- Reading a read receipt through `/sync` needs cache-busting: Synapse caches *initial* `/sync`
  responses for about two minutes keyed by the filter, so polling with a constant filter replays a
  pre-receipt snapshot. `ApiUser.getReceipts` varies the filter per call; `readReceiptOf` also picks
  the newest `m.read` by `ts`, because a user can hold both a threaded (`thread_id: "main"`, what
  matrix-js-sdk sends) and an unthreaded receipt at different positions.
- `workers: 1` and `fullyParallel: false`: the suite drives one shared homeserver and several tests
  assert on live cross-user updates.
