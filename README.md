# Kerbcue

Kerbcue lets couriers claim and run delivery jobs with a tap on Even Realities G2 glasses. R1 ring taps use the same action. Physical R1 testing is pending. Dispatchers post jobs in a Telegram group. Each courier links their own Telegram account once, so every claim shows their real Telegram name. After a claim, the next taps mark the job **Picked up** and then **Delivered**, and Kerbcue edits the original Telegram job card in place at each step. When the dispatcher gives pickup and drop-off coordinates, the glasses show the distance, clearly labelled.

## How it works

| Step | Dispatcher (Telegram group) | Courier (glasses or R1 ring) |
| --- | --- | --- |
| Link, once per device | — | The glasses show a code. The courier sends `/start CODE` to the bot, or opens the link on the phone. |
| Available | Posts `/job pickup: … \| drop: … \| pay: …`, optionally with coordinates or location pins. The bot posts a job card. | Swipes through open jobs. Each shows pickup, drop, pay and distance. |
| Claimed | The card changes to **Claimed by Alex Ade** and the bot replies once in the group. | Taps to claim. If two couriers tap at once, exactly one wins. The other sees **Job already taken**. |
| Picked up | The same card changes to **Picked up by Alex Ade** with the time. | Taps again at the pickup. |
| Delivered | The same card changes to **Delivered by Alex Ade** with the full timeline. | Taps again at the door. The glasses return to the open jobs. |

Only the courier who claimed a job can move it forward. Steps can't be skipped or repeated.

## Who uses it and who pays

- **Daily users: couriers.** Bicycle and motorbike couriers and delivery riders who need their hands and eyes on the road. They claim and update jobs without unlocking a phone.
- **Paying customers: small delivery fleets and dispatch teams already dispatching in Telegram groups.** This is common for local courier companies, restaurants with their own riders, and pharmacy or parcel runners. Kerbcue plugs into the group they already use, with no new dispatcher app to learn.
- **Proposed model: a monthly subscription per active courier**, counting couriers who claimed at least one job that month. A pilot price would be set with the first fleets. **We have not validated this pricing with customers yet.**
- **What the fleet gets:** faster job pickup because the first free courier claims with one tap, no double-assigned jobs, and a live status trail on each Telegram card (claimed → picked up → delivered, with names and times) without phoning riders.

Built by Toyyib Olamilekan for Messaging & News and Best Telegram Integration at Heads Up: Even Realities. Kerbcue started on 23 Nov 2026 after the build window opened at 08:00 UTC. The project did not exist before that date. It started from the official Even Hub minimal template. [Hackathon](https://dorahacks.io/hackathon/even-realities/detail) · [Template](https://github.com/even-realities/evenhub-templates/tree/main/minimal)

## Run the local demo

Use Node.js 22.18 or later. The project pins Even Hub SDK 0.0.16, CLI 0.2.0, and simulator 0.9.5. The SDK requires Even Realities App 2.2.10 or later.

```sh
npm install
cp .env.example .env
npm list @evenrealities/even_hub_sdk
```

The CLI and simulator are installed locally by `npm install`. To use the commands directly from your shell, install them globally.

```sh
npm install -g @evenrealities/evenhub-cli@0.2.0 @evenrealities/evenhub-simulator@0.9.5
```

Run each of these commands in its own terminal from the project directory.

| Terminal | Command | Purpose |
| --- | --- | --- |
| 1 | `npm run server` | Start the backend at `http://localhost:8787`. |
| 2 | `npm run dev` | Start Vite at `http://localhost:5173`. |
| 3 | `npm run simulate` | Open the Even Hub simulator pointed at Vite. |

Keep the bot token blank. Without a token, the backend runs in demo mode. `POST /couriers/demo-link` stands in for the Telegram `/start` step. The glasses first show **Link your Telegram** and a code. Link that code in another terminal.

```sh
curl -fsS -X POST http://localhost:8787/couriers/demo-link \
  -H 'Content-Type: application/json' \
  -d '{"code":"CODE_FROM_GLASSES","name":"Alex"}'
```

Add a demo job. Coordinates are optional. Put them after `@` as `latitude,longitude`.

```sh
curl -fsS -X POST http://localhost:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{"pickup":"Tafawa Balewa Square @ 6.4497,3.3968","drop":"Eko Hotel @ 6.4267,3.4297","pay":"3000 NGN"}'
```

An empty body `{}` adds a sample job with no coordinates. Open jobs appear within a few seconds. Use **Up** or **Down** to browse, **Click** to claim the displayed job, and **Double Click** to open the system exit dialog. After a claim, the glasses show **My job**. Click marks it **Picked up**, then **Delivered**. If another courier wins first, the glasses show **Job already taken** and move to the next open job.

To simulate a second courier, open a second simulator at `http://localhost:5173/?courier=b`. It keeps its own link. You can also use curl with the second device key from `POST /couriers/link`.

```sh
curl -fsS http://localhost:8787/jobs
npm test
```

## Connect a Telegram dispatch group

1. Open [@BotFather](https://t.me/BotFather), run `/newbot`, and choose a bot name and username. Save the token privately in your local `.env` as `TELEGRAM_BOT_TOKEN`.
2. Disable Group Privacy with `/setprivacy` → **Disable**, or make the bot a group admin, so it can see plain-text job posts. [Telegram group privacy FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)
3. Add the bot to your dispatch group and start the backend with the token set. Leave `TELEGRAM_GROUP_CHAT_ID` blank and send a message in the group. The backend logs the negative chat ID it sees. Set `TELEGRAM_GROUP_CHAT_ID` to that ID and restart the backend. It now accepts jobs from that group.
4. Optionally use BotFather’s `/setcommands` to add `job` to the bot’s command menu.

Post a job command in the group.

```text
/job pickup: Central Station | drop: 42 Market Street | pay: 15 USD | note: leave at reception
```

The `pickup`, `drop`, and `pay` fields are required. `note` is optional. When `TELEGRAM_DISPATCHER_IDS` is unset, dispatchers can also paste the fields without `/job`, separated by pipes or one field per line.

**Distance.** Add coordinates as `pickup: Central Station @ 6.4541, 3.3947`. You can also reply to the bot’s job card with a Telegram location pin. The first pin sets the pickup, and the second sets the drop-off. The card is edited to show the distance. By default, Kerbcue shows the great-circle distance between pickup and drop-off, labelled **straight-line**, for example `2.4 km straight-line`. It is not a road distance. If either point is missing, Kerbcue shows no distance. It never guesses a distance or travel time.

**Optional route and travel time.** Set `KERBCUE_ROUTING_URL` to an OSRM-compatible server and `KERBCUE_ROUTING_PROFILE` to its label. Then cards show road distance and travel time, for example `6.9 km bike route, ~29 min`. Example: `https://routing.openstreetmap.de/routed-bike` with profile `bike`. That public FOSSGIS server is free and needs no key. It is a shared demo service with a fair-use policy, so self-host OSRM for real fleets. If the router fails or times out after 4 seconds, Kerbcue falls back to straight-line distance. The estimate covers pickup to drop-off, not the courier’s current position.

**Courier identity.** The glasses ask the backend for a one-time link code, valid for 15 minutes. The courier sends `/start CODE` to the bot in a private chat. When the backend knows the bot username, the companion phone screen shows a `t.me` link that does this. The bot checks that the sender belongs to the dispatch group with [getChatMember](https://core.telegram.org/bots/api#getchatmember). It then binds that device to the sender’s Telegram user ID and name. Only a SHA-256 hash of the device key is stored. Claims and status updates are attributed to the linked Telegram account. A name sent by the client is ignored, so one courier can’t claim as another. Two pairs of glasses linked to the same Telegram account count as the same courier.

The backend uses [getUpdates](https://core.telegram.org/bots/api#getupdates) to long-poll without a public webhook. It posts an open card with a job ID using [sendMessage](https://core.telegram.org/bots/api#sendmessage). When a courier taps, the backend reserves the job synchronously before any Telegram call, so two simultaneous claims can’t both win. It then edits the original card to **Claimed by …** with the UTC time and posts one reply in the group. A different courier gets HTTP 409. The same courier gets the existing claim with `telegramSynced: null` and no additional Telegram writes. Picked up and Delivered only edit the original card with [editMessageText](https://core.telegram.org/bots/api#editmessagetext), so the group isn’t flooded. If a Telegram write fails, the status change stays recorded and the API returns `telegramSynced: false`.

### API

| Route | Who | Result |
| --- | --- | --- |
| `GET /jobs` | Any device. Send `Authorization: Bearer <deviceKey>` for your own jobs. | Open jobs, your active jobs, and your linked courier |
| `POST /couriers/link` | A new device | `{ code, deviceKey, expiresAt, link? }` |
| `POST /jobs/:id/claim` | A linked device | 200 claimed, 409 taken, 401 not linked |
| `POST /jobs/:id/status` with `{"status":"picked_up"}` or `"delivered"` | The claiming courier | 200 advanced, 409 invalid or duplicate step, 403 not your job, 401 not linked |
| `POST /jobs`, `POST /couriers/demo-link` | Demo mode only | Add a job, or link a code to a name |

Demo-only routes exist when the token is blank and `NODE_ENV` is anything other than `production`.

## Security and limits

- **Backend access.** The backend listens on all interfaces (`0.0.0.0`). Claims and status updates need a device linked through Telegram by a member of the dispatch group. Listing open jobs needs no login, so anyone who can reach port 8787 can see pickup and drop-off addresses. Run it on a trusted network or behind HTTPS. The device key is a bearer secret stored on the phone, so anyone who copies it can act as that courier. No API keys ship inside the plugin. `PUBLIC_ORIGIN` defaults to `*` when unset.
- **Dispatchers.** By default, members of the configured Telegram group can post jobs. Set `TELEGRAM_DISPATCHER_IDS` to a comma-separated list of positive Telegram user IDs to restrict `/job` intake to those users and anonymous admins posting as the group. Anonymous admins can still use structured plain text.
- **Restarts.** By default, jobs, linked couriers and the Telegram offset live in memory and reset on restart. Set `KERBCUE_DATA_FILE`, for example to `./data/kerbcue.json`, to save them, including each job’s claimed, picked-up and delivered times. Pending link codes live only in memory. After a restart, the glasses request a new code. Data files from earlier versions still load. Telegram may redeliver unconfirmed posts from the past 24 hours. Kerbcue uses the saved offset to skip updates it already recorded.
- **Telegram card failures.** If Telegram rejects a card post, Kerbcue retries it up to three times. If the result is uncertain or retries run out, Kerbcue keeps the job open without a card. A claim still works and returns `telegramSynced: null`.
- **One active job per screen.** The glasses show the courier’s oldest active job until it is delivered. A single accidental tap moves that job forward one step, and there is no undo from the glasses yet.

## Configure the backend origin

Edit the first entry under `permissions` → `network` → `whitelist` in `app.json` to change the backend URL. The plugin reads its API base from that same entry, so its requests and the whitelist use the same origin. Set a full origin with no trailing slash. Keep `http://localhost:8787` for the local simulator. For a deployed headset, use an HTTPS backend the phone can reach.

For a phone on your LAN, replace `http://localhost:8787` with `http://<LAN-IP>:8787` and set the backend’s `PUBLIC_ORIGIN` to `http://<LAN-IP>:5173`. In the simulator the Vite origin is `http://localhost:5173`. For a packaged WebView, set `PUBLIC_ORIGIN` to the WebView origin, or use `*` for a local demo. The backend handles the JSON claim request’s CORS preflight. [Even Hub networking](https://hub.evenrealities.com/docs/build/networking)

## Build and package

```sh
npm run build
evenhub pack app.json dist -o kerbcue.ehpk --sdk-ver 0.0.16
```

`npm run pack` runs both commands with the local CLI. `dist/index.html` is the entrypoint. The CLI derives the minimum Even App version from the SDK at pack time. The web build reads its backend origin from `app.json`. Telegram configuration lives in the backend’s local `.env`, which is ignored along with `.ehpk` files. [Even Hub packaging](https://hub.evenrealities.com/docs/ship/packaging)

For a later LAN test on the glasses, point the phone at the Vite server with `evenhub qr --url "http://<LAN-IP>:5173"`.

## Verification

- **Backend tests passed** on Node.js 24 (27 tests). They cover Telegram job parsing, group filtering, listing open jobs, concurrent claims, HTTP 409, demo creation, and CORS preflight. Mocked Telegram requests verify the chat, topic, and message IDs used to update and reply to the original bot card. Newer tests cover Telegram `/start` linking, including the group-member check and expired codes. They also cover two linked couriers racing for one job, status updates from the wrong courier or an unlinked device, and skipped, duplicate and backward steps. The rest cover a failed card edit, missing or invalid coordinates, straight-line distance, router fallback, location pins, and restarts.
- **The courier identity, status and distance screens on the glasses have not been re-run in the simulator or on hardware yet.** The simulator results below are from the first version.
- **Vite build and Even Hub packaging passed.** The CLI produced `kerbcue.ehpk` with SDK 0.0.16 and stamped Even Realities App 2.2.10 as the minimum version.
- **Even Hub Simulator 0.9.5 ran against Vite** with the token-free sample backend. The empty state, polling, swipe navigation, and tap-to-claim worked. The selected delivery left the open list and the glasses frame showed **Claimed by Courier**.
- **Double-tap exercised the SDK’s mode-1 exit call.** The simulator cleared the glasses frame. Visual verification of the system dialog remains for a hardware run.

## Official references

- [Even Hub overview](https://hub.evenrealities.com/docs/get-started/overview), [architecture](https://hub.evenrealities.com/docs/get-started/architecture), [tools](https://hub.evenrealities.com/docs/get-started/quickstart/install-tools), [first app](https://hub.evenrealities.com/docs/get-started/quickstart/first-app), and [templates](https://hub.evenrealities.com/docs/get-started/quickstart/templates)
- [Device APIs](https://hub.evenrealities.com/docs/build/device-apis), [networking](https://hub.evenrealities.com/docs/build/networking), [packaging](https://hub.evenrealities.com/docs/ship/packaging), and [simulator](https://hub.evenrealities.com/docs/test/simulator)
- [Even Hub changelog](https://hub.evenrealities.com/docs/reference/changelog) and [FAQ](https://hub.evenrealities.com/docs/reference/faq)
- [Telegram bot introduction](https://core.telegram.org/bots), [group privacy FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get), and [Bot API](https://core.telegram.org/bots/api)
