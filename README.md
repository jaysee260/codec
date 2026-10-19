# Codec

Codec is a chat app for a small group of friends running their own Matrix server. It looks and feels
like Discord: spaces down the left, channels and DMs next to them, messages in the middle. It talks to
a regular Matrix homeserver (Synapse), so nothing about it is locked to one server.

The goal is private, end-to-end encrypted chat on hardware you own. New channels and DMs are encrypted by
default, and a recovery key unlocks your message history on a new device.

## What works today

- Spaces, channels, DMs, a member list
- Replies, reactions, file and image uploads, link preview cards
- Threads, opened in a side panel like Discord
- Voice notes and encrypted voice calls (one to one and in channels)
- A GIF picker
- Read receipts: "sent", then the avatars of who has seen your message
- A phone layout, plus Android and iOS builds
- Logging in with a password or through your server's SSO page

No video calls yet.

## Running it on your machine

You need Node and either Docker or WSL (more on that below).

```bash
npm install
npm run hs:up     # starts a local Matrix server on http://localhost:8008
npm run seed      # adds test users, a couple of spaces and some chat history
npm run dev       # opens the app on http://localhost:5173
```

Log in as `alice` with password `password123`. There are also `bob`, `carol` and `dave`, same password.
`docs/SEED_DATA.md` lists what the seed creates.

To run the tests: `npm run test:e2e`. It starts its own homeservers and takes a few minutes; `npm run test:e2e:smoke`
is the quick version. Every other command is listed in `docs/RUNBOOK.md`.

When you're done, `npm run hs:down` stops the server. `npm run seed:reset` wipes it and starts the
test data over.

### Docker or WSL?

`npm run hs:up` uses Docker if it can. On a Windows PC where virtualization is turned off and Docker
won't start, it installs Synapse inside WSL1 instead. Either way you end up with the same server on the
same port. `homeserver/README.md` has the details.

## Settings

Copy `.env.example` to `.env` if you want to change anything. Two settings matter:

- `VITE_HS_URL` is the server the app connects to. You can also change it on the login screen under
  Advanced.
- `VITE_GIF_API_KEY` is a [Klipy](https://docs.klipy.com/) key for real GIF search. Without one, the
  picker shows a handful of built-in GIFs so you can still try it.

## Trying it on a phone

Your phone and PC need to be on the same Wi-Fi.

```bash
npm run hs:lan    # lets the phone reach the server, and prints the address to use
npm run dev:lan   # serves the app to the phone
```

Open the printed address in the phone's browser. Voice notes can be played this way but not recorded;
recording needs the Android app, which `npm run cap:build:android:lan` builds. The full walkthrough,
including iOS, is in `docs/MOBILE.md`.

## Finding your way around the code

- `src/lib/` and `src/store/` hold the Matrix connection and app state
- `src/features/` has the screens: navigation, conversation, GIFs, link previews, security, calls, receipts
- `e2e/` is the Playwright test suite
- `homeserver/`, `seed/` and `scripts/` are for running the local server and test data
- `docs/` has the guides, with an index in `docs/README.md`

Start with `docs/ARCHITECTURE_DIAGRAMS.md` for the pictures, then `docs/ARCHITECTURE.md` for how the app is built.
Read the latter before changing anything in `src/lib/` or `src/store/`; the rest of the app depends on it.
