# Plug this bot into your Meta WhatsApp account

Goal: the Cloud API bot answers the **same number** already on WhatsApp Business (Coexistence), so you can start messaging clients.

You need a **public https URL** for `/webhook`. Meta cannot call `localhost`.

## 1. Values from Meta Developer

Open [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp → API Setup**.

| `.env` key | Where it is |
|---|---|
| `WHATSAPP_TOKEN` | Temporary access token (testing) or a **system-user** token that never expires (production) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID (not the digits clients dial) |
| `WHATSAPP_WABA_ID` | WhatsApp Business Account ID (optional, used by `check-meta`) |
| `WHATSAPP_VERIFY_TOKEN` | Any long random string **you** invent — you paste the same value into Meta |
| `WHATSAPP_APP_SECRET` | App Dashboard → Settings → Basic → App Secret |
| `PUBLIC_BASE_URL` | Public origin of this process, no trailing slash, e.g. `https://abc.ngrok-free.app` |
| `NODE_ENV` | `production` on a real host (forces webhook HMAC) |

```bash
cp .env.example .env
```

## 2. Coexistence (keep the Business App)

This bot is built for **the existing Business number**, not a new API-only number.

1. WhatsApp Manager / Embedded Signup: connect that number with **Coexistence** so the phone app stays live.
2. Do not delete the WhatsApp Business app from the handset.
3. After connect, 1:1 chats sync. Labels / greeting / quick replies stay **in the app only** — Cloud API cannot set those labels.

Until Coexistence is on, a Cloud API token for a *different* test number still works for `send-test`. Live client chats on your sales number need Coexistence on **that** number.

## 3. Run the bot where Meta can reach it

Local:

```bash
npm install
npm start
```

In another terminal, tunnel port 3000 (ngrok, cloudflared, or similar):

```bash
ngrok http 3000
```

Set `PUBLIC_BASE_URL` to that `https://…` origin and restart.

Production: any Node 18+ host (Render, Railway, Fly, a VM). `PORT` is read from the environment. Health check: `GET /health`.

## 4. Point Meta at `/webhook`

Developer app → **WhatsApp → Configuration** (or the webhook panel on API Setup):

- Callback URL: `{PUBLIC_BASE_URL}/webhook`
- Verify token: exactly `WHATSAPP_VERIFY_TOKEN`
- Subscribe to **messages**

Meta sends `GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. A 200 with the challenge means the handshake worked.

Then send a WhatsApp message **from a test phone to the business number**. You should see a POST in the bot logs and a reply (once copy is filled).

## 5. Confirm credentials

```bash
npm run check:meta
```

This loads `.env`, checks missing keys, and `GET`s the phone number on Graph. If this fails, the token or phone-number ID is wrong — do not debug the FSM yet.

## 6. Send a first message

**Template** (works even if they have not messaged you). Meta ships `hello_world` on new apps:

```bash
npm run send:test -- --to 2782XXXXXXXX --template hello_world --lang en_US
```

Use the client number in international form, no `+` or spaces (`2782…` not `082…`).

**Free-form text** only works inside the 24-hour window after *they* message you (or after a template they reply to):

```bash
npm run send:test -- --to 2782XXXXXXXX --text "Test from the dealership bot"
```

If Graph returns `#131047`, the 24h window is closed — use a template.

## 7. Before real clients

1. Fill `src/content/copy.js`. Blank keys send empty WhatsApp bodies.
2. Put a **system user** permanent token in `WHATSAPP_TOKEN` (the dashboard token dies in hours).
3. Keep `WHATSAPP_APP_SECRET` set. Production rejects unsigned webhook POSTs.
4. Submit any templates you will send outside 24h (declines, reminders) in WhatsApp Manager → Message templates. Utility copy reviews cleaner than marketing.
5. Add a payment method on the WABA if you will send paid template conversations.
6. Pilot: you text the business number, walk GREETING → qualify / decline / `help`.

## 8. What “messaging clients” means on this bot

| You want | How |
|---|---|
| Client texts the sales number, bot answers | Webhook + copy filled. This is the live path. |
| You text a client first | Approved template via `send-test` or later sheet automation |
| Status on a Google Sheet sends “declined” | Not wired yet — needs `/sheet-events` + a decline template |
| Auto-change WhatsApp **labels** | Not possible on Cloud API |

Staff can still reply in the WhatsApp Business app on the same thread (Coexistence). The bot goes quiet after `help` / `stop` / handover.

## Troubleshooting

| Symptom | Check |
|---|---|
| Webhook verify fails | `WHATSAPP_VERIFY_TOKEN` matches Meta; URL is `https` and ends with `/webhook` |
| POST 403 | `WHATSAPP_APP_SECRET` must match the app that signed the webhook |
| POST 503 in production | App secret missing |
| Send `#100` | Payload had a non-Graph field (this bot strips `mediaSlot`) |
| Send `#190` | Token expired — create a system-user token |
| Send `#131047` | Outside 24h — use a template |
| Empty replies | `src/content/copy.js` still blank |
| `check-meta` Graph fail | Wrong token, phone-number ID, or app does not own that WABA |
