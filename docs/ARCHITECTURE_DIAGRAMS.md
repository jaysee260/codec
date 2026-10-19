# Architecture diagrams

Codec is a chat app for a small group of friends running their own Matrix server. These pictures show how it works.
Each one has a few plain lines above it saying what it shows and below it saying what to take away.

**Which picture answers your question?**

| You are wondering about | Look at |
|---|---|
| What talks to what | 1 |
| Where a piece of code belongs, what may import what | 2 |
| Login, loading screen, "Session expired" | 3 and 4 |
| A message not showing up, or showing late | 5 |
| Sending, local echo, "sending" vs "sent" | 6 |
| Images not loading, voice notes | 7 |
| A thread, replies missing from the channel | 8 |
| "Unable to decrypt", the security banner, recovery keys | 9 |
| Link cards and "Show preview" | 10 |
| A voice call from ring to "Call ended" | 11 |
| Phone layout, drawers, the Android back button | 12 |
| The beta at 704.chat: which box runs what | 13 |

The diagrams are [Mermaid](https://mermaid.js.org/). GitHub renders them; in VS Code install a Mermaid preview
extension, or paste one into [mermaid.live](https://mermaid.live). Solid arrows are the normal path, dotted arrows
happen only sometimes (after a click, on an error), and thick arrows carry call audio.

When a diagram and the text disagree, `docs/ARCHITECTURE.md` and `docs/CORE_API.md` win.

1. [The big picture](#1-the-big-picture)
2. [Layers inside the app](#2-layers-inside-the-app)
3. [Signing in and starting up](#3-signing-in-and-starting-up)
4. [Session states](#4-session-states)
5. [How a message reaches the screen](#5-how-a-message-reaches-the-screen)
6. [Sending a message](#6-sending-a-message)
7. [Images, files and voice notes](#7-images-files-and-voice-notes)
8. [Threads](#8-threads)
9. [Encryption and device trust](#9-encryption-and-device-trust)
10. [Link previews](#10-link-previews)
11. [A voice call](#11-a-voice-call)
12. [Screen layout and the back button](#12-screen-layout-and-the-back-button)
13. [Where everything runs (704.chat)](#13-where-everything-runs-704chat)

## 1. The big picture

Codec is a single-page app that runs in the browser (or inside the Capacitor shell on a phone). It talks to one
Matrix homeserver for everything: sign-in, messages, files and link previews. Sign-in can hand off to the
homeserver's SSO provider (Keycloak on the beta). Two kinds of content come straight from third parties: GIFs
(hot-linked from Klipy; in encrypted rooms a GIF loads only after a click) and YouTube / Spotify players inside
link previews.

```mermaid
flowchart LR
  subgraph Device["User's browser or phone"]
    App["Codec web app<br/>React + matrix-js-sdk"]
    SW["Media service worker<br/>adds the sign-in token to image requests"]
    Store[("Local storage<br/>session, homeserver URL,<br/>encryption keys in IndexedDB")]
    App --- SW
    App --- Store
  end

  HS["Matrix homeserver<br/>Synapse"]
  SSO["SSO provider<br/>Keycloak"]
  Klipy["Klipy<br/>GIF search and images"]
  Embeds["YouTube (nocookie) / Spotify<br/>players"]
  RTC["Call server<br/>LiveKit + lk-jwt-service"]

  App -- "sync, send, rooms, keys" --> HS
  SW -- "authenticated media" --> HS
  App -- "link previews" --> HS
  App -. "SSO redirect" .-> SSO
  SSO -. "login token" .-> HS
  App -- "GIF search and images" --> Klipy
  App -. "only after a click" .-> Embeds
  App -- "call ticket, then encrypted call audio" --> RTC
  RTC -. "checks the Matrix login" .-> HS
```

The *media service worker* is a small script the browser runs next to the page. It adds the sign-in token to image
requests, because an `<img>` tag cannot do that itself. Link previews are fetched by the homeserver, not the browser,
so the linked site never sees the user's address. In encrypted rooms GIF images and previews load only after a click.

Voice calls add a call server. Codec finds it in the homeserver's well-known file, asks it for a call ticket, and sends
audio there already encrypted, so the call server only forwards it.

## 2. Layers inside the app

Code is split into four layers, and imports only go downwards. An arrow means "may import from". Feature screens never
send anything through matrix-js-sdk themselves (they only use its types and enums); they read state through store hooks
and change things through the action functions in `src/lib/matrix`.

```mermaid
flowchart TB
  subgraph AppL["src/app: the shell"]
    AppC["App: picks Login, Loading or Shell"]
    Shell["Shell: desktop grid / phone drawers"]
  end

  subgraph Features["src/features: what users see"]
    Nav["navigation<br/>spaces, channels, DMs, thread list,<br/>channel header, members, dialogs"]
    Conv["conversation<br/>messages, composer, threads"]
    Gif["gif<br/>GIF picker"]
    LP["link-preview<br/>cards and embeds"]
    Sec["security<br/>banner and setup / verify / unlock dialogs"]
  end

  subgraph StoreL["src/store: app state (Zustand)"]
    Stores["session, rooms, timeline, threads,<br/>security, layout, toast"]
    Bridge["bridge: SDK events into stores"]
  end

  subgraph Lib["src/lib: no React UI"]
    Matrix["matrix<br/>client, actions, crypto, media"]
    Other["preview, gif, audio,<br/>format, native"]
  end

  SDK["matrix-js-sdk<br/>+ Rust crypto (WASM)"]

  AppL --> Features
  AppL --> StoreL
  AppL --> Lib
  Conv --> Gif
  Conv --> LP
  Features --> StoreL
  Features --> Lib
  StoreL --> Lib
  StoreL --> SDK
  Bridge --> Stores
  Matrix --> SDK
  SDK -- "events" --> Bridge
```

Who owns which folder is in `docs/ARCHITECTURE.md`, "Who works on what".

## 3. Signing in and starting up

On page load the app first registers the media service worker, then tries to resume a saved session. A fresh SSO
login arrives as a `loginToken` in the URL and is swapped for a session. Encryption starts before syncing, because
the SDK needs it ready for the first batch of messages. The loading screen shows two stages: "crypto" then "sync".

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant SW as Media worker
  participant App as App + session store
  participant SDK as matrix-js-sdk
  participant HS as Homeserver

  B->>SW: register media-sw.js
  B->>App: render App
  App->>App: restore(): SSO token in URL? saved session?
  alt SSO token in the URL
    App->>HS: log in with the token
    HS-->>App: new session (new device)
    Note over App: token expired? fall back to the saved session, if any
  else saved session
    App->>App: read it from localStorage
  else neither
    App-->>B: show the login screen (stops here until the user signs in)
  end
  App->>SDK: createClient
  App->>SDK: start encryption (loading stage "crypto")
  App->>SDK: startClient with threads on (loading stage "sync")
  App->>App: bind store bridge and security store
  SDK->>HS: first /sync
  HS-->>SDK: rooms, messages, keys
  SDK-->>App: sync prepared
  App->>HS: fetch my profile
  App-->>B: show the Shell
```

## 4. Session states

The session store's `status` decides which screen is on show. Failures land back on the login form, with a message
when there is something to say (for example "Session expired" when the server revokes the device).

```mermaid
stateDiagram-v2
  state "logged-out: Login screen" as logged_out
  state "logging-in: Login screen (busy)" as logging_in
  state "error: Login screen with message" as error
  state "syncing: Loading screen" as syncing
  state "ready: Shell" as ready

  [*] --> syncing: saved session found
  [*] --> logged_out: no saved session
  logged_out --> logging_in: sign in / register / SSO return
  syncing --> logging_in: SSO return (saved session too)
  error --> logging_in: try again
  logging_in --> syncing: session created
  logging_in --> error: wrong password, expired SSO token
  syncing --> ready: first sync done
  syncing --> logged_out: saved session no longer works
  syncing --> error: new sign-in fails to start
  ready --> logged_out: log out
  ready --> error: token revoked by the server
  ready --> ready: connection drops and returns, footer says Reconnecting
```

Logging out, or losing the token, also stops the client, wipes this device's encryption store, and clears the room,
timeline, thread, security and link-preview caches, so the next person on the same browser starts clean.

## 5. How a message reaches the screen

matrix-js-sdk keeps the live model of every room. The bridge listens to its events and copies the parts the UI needs
into the stores, batching bursts so React renders once per burst, not once per event (50 ms for the room list,
30 ms for timelines). Components only ever read the stores.

```mermaid
flowchart LR
  HS["Homeserver<br/>/sync"] --> SDK["matrix-js-sdk<br/>rooms, timelines, threads"]
  SDK -- "encrypted event" --> Crypto["Rust crypto<br/>decrypts"]
  Crypto -- "decrypted (also later,<br/>e.g. keys from backup)" --> SDK
  SDK -- "room, member, receipt,<br/>account data events" --> Bridge
  SDK -- "timeline, redaction,<br/>local echo, typing, decrypted" --> Bridge
  SDK -- "thread events (per room)" --> Bridge
  Bridge["Bridge<br/>batches bursts"] --> Rooms["rooms store<br/>sidebar, unread counts"]
  Bridge --> Timeline["timeline store<br/>messages per room and thread"]
  Bridge --> Threads["threads store"]
  Rooms --> UI["Components via hooks<br/>useTimeline, useRoomSummary, ..."]
  Timeline --> UI
  Threads --> UI
```

Scrolling up asks the SDK for older messages (`paginateBack`); the results come back through the same path.

Thread replies take a separate path; diagram 8 shows it.

## 6. Sending a message

Features call one action function per kind of message. The SDK shows the message straight away as a "local echo",
encrypts it when the room is encrypted, and sends it. When the server confirms, the echo turns into the real event.

```mermaid
sequenceDiagram
  autonumber
  participant C as Composer
  participant A as actions.ts
  participant SDK as matrix-js-sdk
  participant HS as Homeserver
  participant UI as Message list

  C->>A: sendText(room, body, reply / mentions / thread)
  A->>SDK: sendMessage (into the thread when one is open)
  SDK-->>UI: local echo (shown as sending)
  opt room is encrypted
    SDK->>SDK: share room keys (usually done when the composer opened), then encrypt
  end
  SDK->>HS: PUT /send
  HS-->>SDK: event id
  SDK-->>UI: echo becomes the sent message
  Note over C,UI: Edits, deletes and GIFs follow the same path (reactions too, but they are never encrypted).<br/>Files and voice notes upload first behind an "Uploading..." bar, then send this way.
```

New channels and DMs are encrypted by default; spaces are not (they only hold the channel list).

## 7. Images, files and voice notes

Browsers cannot attach a sign-in token to an `<img>`, so a service worker adds it to media requests for the user's
own homeserver. (Without the worker, for example on a plain-http LAN address, the app falls back to the older
unauthenticated media URLs.) In encrypted rooms files are encrypted in the browser before upload; the server only
stores scrambled bytes and cannot make thumbnails, so the app downloads and decrypts the file itself.

```mermaid
flowchart TB
  subgraph Upload["Sending a file"]
    F["Picked file, photo or voice recording"] --> Enc{"Room encrypted?"}
    Enc -- "yes" --> E1["Encrypt in the browser (AES)"] --> U1["Upload scrambled bytes"]
    Enc -- "no" --> U2["Upload as is"]
    U1 --> Msg["Send message with the file's key"]
    U2 --> Msg2["Send message with the file link"]
  end

  subgraph Show["Showing a file"]
    M["Message with media"] --> Which{"What kind?"}
    Which -- "plain image" --> Img["img tag"] --> SWk["Service worker adds token"] --> HSm["Homeserver media"]
    Which -- "encrypted file" --> Dl["Download with token"] --> Dec["Check and decrypt"] --> Blob["Show from a local blob: URL"]
    Which -- "voice note" --> VDl["Download with token<br/>on first play (decrypt if needed)"] --> Blob
  end
```

Opening a full image or downloading a file also goes through a token-carrying fetch and a local `blob:` URL, since
those are page navigations the service worker cannot see. Voice notes play from a `blob:` URL too, so seeking works.

## 8. Threads

A reply "in thread" never shows in the channel. The SDK keeps one timeline per thread; only the root stays in the
channel, with a summary row under it. Opening a thread shows a side panel on desktop (in place of the member list) or
a full-screen layer on phones. Scrolling up inside a thread loads older replies the same way as in a channel.

```mermaid
flowchart LR
  HS["Homeserver /sync"] --> SDK["matrix-js-sdk"]
  SDK -- "plain message" --> Main["Room timeline<br/>(the channel)"]
  SDK -- "reply with m.thread relation" --> T["Thread timeline<br/>(one per root)"]
  Main --> Root["Root message row<br/>+ summary: 3 replies, bob and carol, 5 min ago"]
  T --> Panel["Thread panel<br/>replies oldest first"]
  Root -- "click" --> Panel
  Comp["Composer in the panel"] -- "sendText(..., { threadRoot })" --> SDK
  SDK -. "local echo (v43 needs the bridge's help)" .-> T
```

Three facts worth keeping in mind: threads never nest (a reply to a reply still belongs to the root); a thread has its
own unread count, cleared only by reading the thread; and typing indicators are room-wide, because Matrix has none for
threads.

## 9. Encryption and device trust

Encryption runs in matrix-js-sdk's Rust engine. Each sign-in is a new device, with its keys kept in this browser's
IndexedDB. The security store watches the engine and tells the banner what to ask for: set up encryption, verify
this session, unlock your message history with the recovery key, or wait while keys restore.

```mermaid
flowchart TB
  Start["Signed in, first sync done"] --> Q1{"Account has an<br/>encryption identity?"}
  Q1 -- "no, and no recovery key" --> Setup["Banner: Set up encryption<br/>creates identity + recovery key + key backup"]
  Q1 -- "no, but a recovery key exists" --> Unlock["Banner: Unlock your message history<br/>enter the recovery key"]
  Q1 -- "yes" --> Q2{"This session verified?"}
  Q2 -- "no" --> Verify["Banner: Verify this session"]
  Verify --> Emoji["Compare emoji with<br/>another signed-in device"]
  Verify --> Unlock
  Q2 -- "yes" --> Q3{"Backup key on this device?"}
  Q3 -- "no" --> Unlock
  Q3 -- "yes" --> Done["No banner:<br/>old messages readable"]
  Emoji -- "backup key arrives" --> Restoring["Banner: Restoring keys"]
  Unlock --> Restoring
  Restoring --> Done
  Setup --> Done
```

Messages the device has no key for show an "unable to decrypt" row that says why (for example "Sent before you
joined" or "Restoring from backup..."). When there is a fix, the row offers an Unlock or Verify button.

## 10. Link previews

Previews are fetched by the homeserver, not the browser, so the user's IP never reaches the linked site. In an
encrypted room, asking the server for a preview would reveal the link, so nothing is requested until the user clicks
"Show preview" (a preview already in the app's cache still shows). YouTube and Spotify links get a player, which
also loads only on click. Every card has a Hide button, and the choice is remembered.

```mermaid
flowchart TB
  Msg["Message with links<br/>up to 3 cards"] --> Cached{"In the app's cache?"}
  Cached -- "yes" --> Card["Preview card"]
  Cached -- "no" --> Enc{"Encrypted room<br/>or encrypted message?"}
  Enc -- "no" --> HS
  Enc -- "yes" --> Btn["Show preview button"] -- "click" --> HS["Homeserver fetches the page<br/>and re-hosts its image"]
  HS --> Cache["Cache: 1 h if found,<br/>5 min if not (so it retries)"]
  Cache -- "found" --> Card
  Cache -- "nothing found" --> None["Plain room: no card<br/>Encrypted: 'No preview available'"]
  Card --> Emb{"YouTube or Spotify?"}
  Emb -- "yes" --> Play["Player loads on click"]
```

## 11. A voice call

Alice presses the call button in an encrypted DM. Bob's device rings, he accepts, both connect to the call server with
their own encryption keys, and when the last person leaves a "Call ended, 12 min" line lands in the chat. The four grey
chat lines (started, declined, ended, missed) are Matrix events, so every device renders the same history.

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice (Codec)
  participant HS as Homeserver
  participant B as Bob (Codec)
  participant LK as Call server (LiveKit)

  A->>HS: join the call session (membership state event)
  A->>HS: ring (notification event, 60 s lifetime)
  HS-->>B: membership + ring
  Note over B: incoming card, ringtone
  B->>HS: join the call session
  A->>LK: call ticket, then connect
  B->>LK: call ticket, then connect
  A-->>B: audio keys as encrypted to-device messages (and back)
  A->>LK: encrypted audio
  LK->>B: forwarded as is
  Note over A,B: in-call screen: mute, speaker, who is talking
  B->>HS: leave
  A->>HS: leave, then post "Call ended" line
```

If Bob declines, he posts a decline event and Alice's DM call ends. If nobody answers within 60 s, or Alice hangs up
while still ringing, Alice posts a "missed" line naming who was rung. A ring in another room during a call is declined
automatically as "busy" and never shown.

## 12. Screen layout and the back button

Wide screens show four columns. Phones (under 768 px wide, or touch screens under 1024 px) show one full-screen
conversation with the navigation and member list in slide-in drawers. Both layouts mount the same feature
components; only the shell around them changes.

```mermaid
flowchart LR
  subgraph Desktop["Desktop"]
    direction LR
    D1["Space rail<br/>72 px"] --- D2["Channels + DMs<br/>user footer<br/>240 px"] --- D3["Security banner<br/>Channel header<br/>Conversation"] --- D4["Members 240 px,<br/>or a thread 400 px"]
  end

  subgraph Phone["Phone"]
    direction LR
    P0["Left drawer<br/>space rail + channels"] -. "menu button" .- P1["Full screen<br/>security banner, header,<br/>conversation or open thread"] -. "members button<br/>or swipe" .- P2["Right drawer<br/>members"]
  end
```

On phones the Android back button closes one thing at a time, from the top down, and only minimises the app when
nothing is open.

```mermaid
flowchart LR
  Back(["Back pressed"]) --> S{"A sheet or call card open?"}
  S -- "yes" --> CloseS["Close it"]
  S -- "no" --> T{"A thread open?"}
  T -- "yes" --> CloseT["Close the thread"]
  T -- "no" --> D{"A drawer open?"}
  D -- "yes" --> CloseD["Close the drawer"]
  D -- "no" --> Min["Minimise the app"]
```

## 13. Where everything runs (704.chat)

The beta's real deployment on JC's homelab, as of 2026-10-19. Web traffic (chat, sign-in, files, call setup) comes in
through the Cloudflare tunnel, and Nginx Proxy Manager sends each name to its box. Cloudflare can't carry live audio,
so call audio comes straight through the home router to LiveKit. New Codec builds go from GitHub through opsbox, where
Hubot builds them and copies the files to LXC 203.

Names in the picture: an *LXC* is a Linux container on the Proxmox server; *opsbox* is the admin machine; *Hubot* is the
ops assistant that deploys; *Nginx Proxy Manager* is the reverse proxy (not the npm package manager). Boxes marked
*planned* are being set up for voice calls (`docs/archive/PHASE7_PLAN.md`, Phase 0).

```mermaid
flowchart LR
  subgraph Devices["People's devices"]
    Browser["Browser<br/>Codec web app"]
    Android["Android phone<br/>Codec app (Capacitor)"]
  end

  subgraph Internet["Internet"]
    CF["Cloudflare tunnel<br/>*.704.chat, web traffic only"]
    Router["Home router (planned forwards)<br/>UDP 50000-50200, TCP 7881"]
    GH["GitHub<br/>code, PRs, CI"]
  end

  subgraph Homelab["Homelab"]
    subgraph SVM["Services VM"]
      CFD["cloudflared"]
      NPM["Nginx Proxy Manager<br/>routes each name, serves<br/>the well-known file"]
    end
    subgraph L203["LXC 203"]
      Synapse["Synapse<br/>matrix.704.chat"]
      PG[("Postgres")]
      Files["nginx: Codec's files<br/>codec.704.chat"]
      Element["Element web<br/>(to be switched off)"]
    end
    subgraph L213["LXC 213 livekit (planned)"]
      LK["LiveKit<br/>rtc.704.chat"]
      JWT["lk-jwt-service<br/>call tickets"]
    end
    KC["Keycloak<br/>single sign-on"]
    subgraph Ops["opsbox"]
      Hubot["Hubot<br/>builds and deploys Codec"]
    end
  end

  subgraph Outside["Outside services"]
    Klipy["Klipy GIFs"]
    Embeds["YouTube / Spotify"]
  end

  Browser -- "HTTPS" --> CF
  Android -- "HTTPS" --> CF
  CF --> CFD --> NPM
  NPM -- "matrix." --> Synapse
  NPM -- "codec." --> Files
  NPM -- "rtc." --> JWT
  NPM -- "rtc." --> LK
  NPM -- "sign-in" --> KC
  Synapse --- PG
  JWT -- "checks the Matrix login" --> Synapse
  Browser == "encrypted call audio" ==> Router
  Android == "encrypted call audio" ==> Router
  Router == "straight in, skips Cloudflare" ==> LK
  GH -. "master" .-> Hubot
  Hubot -. "deploy" .-> Files
  Browser -. "GIFs, players after a click" .-> Klipy
  Browser -.-> Embeds
```
