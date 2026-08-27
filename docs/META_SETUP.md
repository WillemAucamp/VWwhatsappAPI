# Plug this bot into your Meta WhatsApp account

Goal: the Cloud API bot answers the **same number** already on WhatsApp Business (**Coexistence**), using **interactive reply buttons** for the menu tree.

You need a **public https URL** for `/webhook`. Meta cannot call `localhost`.

## 0. Coexistence already done?

If the Business App number is already connected to Cloud API (Coexistence):

1. Skip section 2.
2. Jump to **§1** (copy IDs/token) → **§3** (run bot) → **§4** (webhook) → smoke tests.

Keep the WhatsApp Business app installed on the handset.

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
| `APPLICATION_LINK` | URL sent after a successful qualify |
| `STOCK_LINK` | URL shown on the stock menu step |
| `NODE_ENV` | `production` on a real host (forces webhook HMAC) |

```bash
cp .env.example .env
```

## 2. Coexistence (keep the Business App)

Connect the number that is **already registered on WhatsApp Business App** — do **not** use a migrate/API-only path that removes the phone app.

1. WhatsApp Manager / Embedded Signup: choose **connect existing WhatsApp Business app account** (Coexistence / Business app onboarding).
2. Verify on the handset (in-app code, SMS, or QR). App version must be **≥ 2.24.17**.
3. Do not uninstall WhatsApp Business from the phone.
4. After connect, 1:1 chats sync. Labels / greeting / quick replies stay **in the app only**.

If Meta only offers “migrate number to API” and warns the Business App will stop: **cancel** — that is not Coexistence.

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

Production: any Node 18+ host (Render, Railway, Fly, a VM). Prefer a single process with durable `data/` (sessions + lead logs). Health check: `GET /health`.

## 4. Point Meta at `/webhook`

Developer app → **WhatsApp → Configuration** (or the webhook panel on API Setup):

- Callback URL: `{PUBLIC_BASE_URL}/webhook`
- Verify token: exactly `WHATSAPP_VERIFY_TOKEN`
- Subscribe to **messages**

Meta sends `GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. A 200 with the challenge means the handshake worked.

Then message the business number from a personal phone. You should get an **interactive menu** (tappable options), not only plain text.

## 5. Confirm credentials

```bash
npm run check:meta
```

This loads `.env`, checks missing keys / blank copy, and `GET`s the phone number on Graph. If this fails, the token or phone-number ID is wrong — do not debug the menu tree yet.

## 6. Send a first message

**Template** (works even if they have not messaged you). Meta ships `hello_world` on new apps:

```bash
npm run send:test -- --to 2782XXXXXXXX --template hello_world --lang en_US
```

Use the client number in international form, no `+` or spaces (`2782…` not `082…`).

**Live pilot:** text the business number → tap **Qualify me** → walk licence → income → credit → confirm.

Free-form bot text (and interactive menus) only work inside the **24-hour** window after *they* message you (or after a template they reply to). If Graph returns `#131047`, use a template.

## 7. Before real clients

1. Confirm `src/content/copy.js` matches the Melrose PDF script (already loaded).
2. Set real `APPLICATION_LINK` (Google Form) and `STOCK_LINK`.
3. Put a **system user** permanent token in `WHATSAPP_TOKEN` (dashboard tokens expire).
4. Keep `WHATSAPP_APP_SECRET` set. Production rejects unsigned webhook POSTs.
5. Submit any templates you need outside 24h in WhatsApp Manager.
6. Add a payment method on the WABA if you will send paid template conversations.
7. Open items from the Melrose handoff: Promotions content TBD; Opt-Out currently → human_handover; stocklist uses Continue until dynamic vehicle rows are wired.

## 8. How the interactive menu works

| Layer | Role |
|---|---|
| `src/fsm/states.js` | Branching tree: option key → next state; `optionTitles` = button labels |
| `src/content/copy.js` | Body text above the buttons |
| `src/transport/whatsapp.js` | Graph `type=interactive` (reply buttons ≤3, else list) |
| `POST /webhook` | Accepts `text` and `interactive` (`button_reply` / `list_reply`) |

Staff can still reply in the WhatsApp Business app on the same thread (Coexistence). The bot goes quiet after `help` / `stop` / handover.

## Troubleshooting

| Symptom | Check |
|---|---|
| Webhook verify fails | `WHATSAPP_VERIFY_TOKEN` matches Meta; URL is `https` and ends with `/webhook` |
| POST 403 | `WHATSAPP_APP_SECRET` must match the app that signed the webhook |
| POST 503 in production | App secret missing |
| Taps do nothing | Webhook subscribed to **messages**; bot logs show `interactive` inbound |
| Send `#100` | Payload had a non-Graph field (this bot strips `mediaSlot`) |
| Send `#190` | Token expired — create a system-user token |
| Send `#131047` | Outside 24h — use a template |
| Empty replies | Copy key blank or env links unset |
| `check-meta` Graph fail | Wrong token, phone-number ID, or app does not own that WABA |
| Coexistence missing | You used migrate/API-only; reconnect with Business app onboarding |
