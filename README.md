# VWwhatsappAPI — WhatsApp pre-qualification bot

Single-tenant Cloud API bot for the dealership WhatsApp Business number (**Coexistence**: Business App + API on the same number).

Start here:

1. **Plug into Meta:** [docs/META_SETUP.md](docs/META_SETUP.md)
2. **Write customer copy:** `src/content/copy.js` (still stubs)
3. **Conversation tree:** `src/fsm/states.js`

## Layout

```
src/
  index.js                 Process entry — listen, follow-up scheduler, Meta status log
  app.js                   Express: GET /health, GET|POST /webhook
  config.js                Env → config
  meta/readiness.js        Local “are we plugged in?” snapshot (no secrets)
  transport/whatsapp.js    Graph /messages (text + templates)
  routes/webhook.js        Meta verify handshake + inbound text
  webhook/inboundDedupe.js At-least-once wamid guard
  engine/fsmEngine.js      Session + help-intent + options + follow-ups
  fsm/states.js            State table only
  content/copy.js          Human-owned message text
  content/resolve.js       {{COPY.*}} / link placeholders
  session/store.js         File (default) / memory / Redis
  followup/scheduler.js    30m then every 4h no-reply nudges
  logger/leadLogger.js     Qualify / decline / handover log
scripts/
  check-meta.js            Validate .env and ping Graph
  send-test.js             Send one test text or template
docs/
  META_SETUP.md            Connect this bot to your Meta account
tests/                     FSM paths + webhook / race regressions
data/                      Sessions + lead logs (gitignored)
```

## Run

```bash
cp .env.example .env
# fill Meta values — see docs/META_SETUP.md
npm install
npm test
npm start
```

| URL | Role |
|-----|------|
| `GET /health` | Process up + whether Meta env is filled |
| `GET /webhook` | Meta `hub.verify_token` handshake |
| `POST /webhook` | Inbound customer text |

```bash
npm run check:meta          # token + phone-number lookup
npm run send:test -- --to 2782XXXXXXXX --template hello_world
```

## Behaviour

- Help / stop keywords from any state → `HUMAN_HANDOVER` (bot goes quiet).
- Invalid input: one re-prompt, then handover.
- Soft declines: next inbound restarts at `GREETING`.
- Follow-ups while waiting on a question: 30 minutes, then every 4 hours, max 3.

Flow: `GREETING` → special / stock / qualify → licence → income → credit → confirm → application link **or** decline / handover.

This repo is **not** whatsapp-web.js. Outbound is official Graph `/messages` only.
