# Codec docs

Start with the first two. Everything else is reference you open when you need it.

## Start here

| Doc | Read it when |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want to know how the app is built and what the shared layer guarantees. Read before touching `src/lib`, `src/store` or `src/app`. |
| [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md) | You prefer pictures: the big picture, startup, how a message flows, encryption, calls, the 704.chat deployment. |
| [RUNBOOK.md](RUNBOOK.md) | You need a command: start the homeserver, run one test, build the APK, post sample data. |

## Reference

| Doc | What is in it |
|---|---|
| [CORE_API.md](CORE_API.md) | Every store, hook, action, helper and wire shape, with exact signatures. The file you copy from. |
| [GOTCHAS.md](GOTCHAS.md) | Traps in matrix-js-sdk, Synapse, phones, encryption and the test setup, grouped by area. |
| [MOBILE.md](MOBILE.md) | Phone browser, the Android APK, iOS on a Mac, the LAN proxy, voice calls on Android. |
| [SEED_DATA.md](SEED_DATA.md) | The test users, rooms and messages the seed creates. The fixture contract the tests rely on. |
| [ACCEPTANCE.md](ACCEPTANCE.md) | The `data-testid` registry every test and component uses, plus the original desktop acceptance criteria. |

## Tracking

| Doc | What is in it |
|---|---|
| [STATUS.md](STATUS.md) | Where each feature stands, newest first. |
| [BUGS.md](BUGS.md) | Every bug found by QA, open ones first, with repro steps and the fixing commit. |

## Archive: how each phase was planned and accepted

Nothing under `archive/` is current guidance. If it disagrees with the docs above, the docs above win.

| Doc | What is in it |
|---|---|
| [archive/DECISIONS.md](archive/DECISIONS.md) | Where the code ended up different from the plan, and why, for every phase. |
| `archive/PLAN.md`, `TICKETS.md`, `DEMO.md` | Phase 1: the desktop web client. |
| `archive/PHASE2_*.md` | Phase 2: phone layout, Capacitor, voice notes. |
| `archive/PHASE3_*.md` | Phase 3: threads. |
| `archive/PHASE4_*.md` | Phase 4: the GIF picker. |
| `archive/PHASE5_*.md` | Phase 5: end-to-end encryption. |
| `archive/PHASE6_*.md` | Phase 6: link preview cards. |
| `archive/PHASE7_*.md` | Phase 7: voice calls. |
| `archive/RECEIPTS_*.md` | Read receipts ("sent / seen by"). |
| `archive/PERF_PLAN.md` | How the parallel e2e homeserver pool was designed. |
| `archive/VOICE_FORMAT_PLAN.md` | Why voice notes are sent as Ogg/Opus and how old iPhones play them. |

Each phase has a `PLAN` (goals and scope), `TICKETS` (who builds what), `ACCEPTANCE` (criteria and test ids) and, for
the early phases, a `DEMO` script.

## Not docs

- `advisor/`: probe scripts written while verifying SDK and Synapse behaviour. Some tests and scripts import them.
- `screenshots/`: written by the `scripts/verify-*.mjs` checks.
