# Kerbcue

Kerbcue lets couriers claim delivery jobs with a tap on Even Realities G2 glasses. R1 ring taps use the same claim action. Physical R1 testing is pending. Dispatchers post jobs in a Telegram group. The glasses show one open job at a time, and Kerbcue updates the Telegram job card when someone claims it.

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

Keep the bot token blank and add a demo job in another terminal.

```sh
curl -fsS -X POST http://localhost:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Run the command again with `{"pickup":"Public Library","drop":"18 River Road","pay":"12 EUR"}` as the body to add a different job. Open jobs appear within a few seconds. Use **Up** or **Down** to browse, **Click** to claim the displayed job, and **Double Click** to open the system exit dialog. A successful claim shows **Claimed**. If another courier wins first, Kerbcue refreshes and shows the next open job if one exists.

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

The backend uses [getUpdates](https://core.telegram.org/bots/api#getupdates) to long-poll without a public webhook. It posts an open card with a job ID using [sendMessage](https://core.telegram.org/bots/api#sendmessage). When a courier taps, the plugin sends the visible job ID and the name supplied by the backend’s `COURIER_NAME` setting. The backend reserves the job before sending two Telegram requests in parallel. It marks the original card claimed with the courier name and UTC time and posts a reply in the group. The reply can still post if the card was deleted. A different courier receives HTTP 409 on a repeat claim. The same courier receives the existing claim with `telegramSynced: null` and no additional Telegram writes. The API returns `telegramSynced: false` if either Telegram write fails, and the winning claim stays recorded. [Telegram editMessageText](https://core.telegram.org/bots/api#editmessagetext)

`POST /jobs` creates demo jobs when the token is blank and `NODE_ENV` is anything other than `production`.

## Security and limits

- **Backend access.** The backend listens on all interfaces (`0.0.0.0`) and has no login. Anyone who can reach port 8787 can see pickup and drop addresses and claim jobs under a supplied courier name. The backend trusts the supplied courier name, so run it on a trusted network or put your own per-courier authentication in front of it. No API keys ship inside the plugin. `PUBLIC_ORIGIN` defaults to `*` when unset.
- **Dispatchers.** By default, members of the configured Telegram group can post jobs. Set `TELEGRAM_DISPATCHER_IDS` to a comma-separated list of positive Telegram user IDs to restrict `/job` intake to those users and anonymous admins posting as the group. Anonymous admins can still use structured plain text.
- **Restarts.** By default, jobs and the Telegram offset live in memory and reset on restart. Set `KERBCUE_DATA_FILE`, for example to `./data/kerbcue.json`, to save both. Telegram may redeliver unconfirmed posts from the past 24 hours. Kerbcue uses the saved offset to skip updates it already recorded.
- **Telegram card failures.** If Telegram rejects a card post, Kerbcue retries it up to three times. If the result is uncertain or retries run out, Kerbcue keeps the job open without a card. A claim still works and returns `telegramSynced: null`.

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

- **Backend tests passed** on Node.js 24. They cover Telegram job parsing, group filtering, listing open jobs, concurrent claims, HTTP 409, demo creation, and CORS preflight. Mocked Telegram requests verify the chat, topic, and message IDs used to update and reply to the original bot card.
- **Vite build and Even Hub packaging passed.** The CLI produced `kerbcue.ehpk` with SDK 0.0.16 and stamped Even Realities App 2.2.10 as the minimum version.
- **Even Hub Simulator 0.9.5 ran against Vite** with the token-free sample backend. The empty state, polling, swipe navigation, and tap-to-claim worked. The selected delivery left the open list and the glasses frame showed **Claimed by Courier**.
- **Double-tap exercised the SDK’s mode-1 exit call.** The simulator cleared the glasses frame. Visual verification of the system dialog remains for a hardware run.

## Official references

- [Even Hub overview](https://hub.evenrealities.com/docs/get-started/overview), [architecture](https://hub.evenrealities.com/docs/get-started/architecture), [tools](https://hub.evenrealities.com/docs/get-started/quickstart/install-tools), [first app](https://hub.evenrealities.com/docs/get-started/quickstart/first-app), and [templates](https://hub.evenrealities.com/docs/get-started/quickstart/templates)
- [Device APIs](https://hub.evenrealities.com/docs/build/device-apis), [networking](https://hub.evenrealities.com/docs/build/networking), [packaging](https://hub.evenrealities.com/docs/ship/packaging), and [simulator](https://hub.evenrealities.com/docs/test/simulator)
- [Even Hub changelog](https://hub.evenrealities.com/docs/reference/changelog) and [FAQ](https://hub.evenrealities.com/docs/reference/faq)
- [Telegram bot introduction](https://core.telegram.org/bots), [group privacy FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get), and [Bot API](https://core.telegram.org/bots/api)
