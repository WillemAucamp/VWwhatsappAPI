# VWwhatsappAPI — WhatsApp interactive menu bot

Single-tenant **WhatsApp Cloud API** bot for the dealership Business number (**Coexistence**: Business App + API on the same number).

Customers get **interactive reply buttons** (tap → next menu). Typed text still works as a fallback (`help`, number synonyms, etc.).

Start here:

1. **Plug into Meta:** [docs/META_SETUP.md](docs/META_SETUP.md)
2. **Customer copy:** `src/content/copy.js` (message bodies)
3. **Menu tree + button titles:** `src/fsm/states.js` (`options`, `optionTitles`)

## Layout

```
src/
  index.js                 Process entry — listen, follow-up scheduler, Meta status log
  app.js                   Express: GET /health, GET|POST /webhook
  config.js                Env → config
  meta/readiness.js        Local “are we plugged in?” snapshot (no secrets)
  transport/whatsapp.js    Graph /messages (interactive + text + templates)
  routes/webhook.js        Meta verify + inbound text / button / list replies
  webhook/inboundDedupe.js At-least-once wamid guard
  engine/fsmEngine.js      Session + help-intent + option ids + follow-ups
  fsm/states.js            Branching menu table
  content/copy.js          Message body text
  content/resolve.js       Placeholders + interactive action builder
  session/store.js         File (default) / memory / Redis
  followup/scheduler.js    30m then every 4h no-reply nudges
  logger/leadLogger.js     Qualify / decline / handover log
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
| `POST /webhook` | Inbound text + interactive replies |

```bash
npm run check:meta          # token + phone-number lookup
npm run send:test -- --to 2782XXXXXXXX --template hello_world
```

## Behaviour

- Choice / info turns send Cloud API **interactive** messages (≤3 options → reply buttons; more → list).
- Button / list reply `id` matches FSM option keys (`1`, `yes`, `mid`, …).
- Help / stop keywords from any state → `HUMAN_HANDOVER` (bot goes quiet).
- Invalid input: one re-prompt with the same buttons, then handover.
- Soft declines: next inbound restarts at `GREETING`.
- Follow-ups while waiting: 30 minutes, then every 4 hours, max 3 (re-sends buttons).

Flow: `GREETING` → special / stock / qualify → licence → income → credit → confirm → application link **or** decline / handover.

This repo is **not** whatsapp-web.js. Outbound is official Graph `/messages` only.
