# WhatsApp Pre-Qualification Bot — Logic & FSM

Conversation logic tree for a vehicle-dealership WhatsApp pre-qualification bot. Structure only: state machine, transitions, stub message keys. No advice or sales copy is generated here.

## Integration

Runs on the dealership’s **existing WhatsApp Business number** via Meta **Coexistence** (Cloud API + Business App on the same number). Inbound webhooks + outbound Graph `/messages`. Not whatsapp-web.js.

Outbound sending is isolated behind `sendMessage(to, payload)` in `src/transport/whatsapp.js` so transport changes do not rewrite the FSM.

## Layout

| Path | Role |
|------|------|
| `src/fsm/states.js` | FSM **state table** (data only) |
| `src/engine/fsmEngine.js` | Session resolve, help-intent, options, invalid retries, path updates |
| `src/content/copy.js` | Stub `{{COPY.*}}` keys (blank; human-owned) |
| `src/transport/whatsapp.js` | `sendMessage` + optional agent notify |
| `src/logger/leadLogger.js` | Pluggable lead logger (console / file / jsonl) |
| `src/session/store.js` | Per-number session (file default; memory; Redis optional) |
| `src/routes/webhook.js` | Cloud API webhook verify + inbound |
| `src/config.js` + `.env.example` | Keywords, max invalid attempts, TTL, links, credentials |
| `tests/manual-test.js` | Path / decline / invalid / help-intent exercises |

## Behaviour (engine)

- **Help intent** (configurable keywords) checked before option match → `HUMAN_HANDOVER` from any state.
- **Help footer** appended on every bot turn from `help_footer`.
- **Invalid input**: one re-prompt; then escalate to `HUMAN_HANDOVER` after `MAX_INVALID_ATTEMPTS`.
- **Terminals** log `{ waNumber, timestamp, exitReason, path }`.
- **Soft declines** (`soft_closed`): next inbound message restarts at `GREETING`.
- **Human handover** (`quiet`): silent until `REOPEN_KEYWORDS` or session TTL expiry.

## Flow (summary)

`GREETING` → `SPECIAL_INFO` | `STOCK_LIST` | `LICENSE_CHECK` → income → credit → confirm → `QUALIFIED_LINK` or decline / handover terminals. See `src/fsm/states.js`.

## Setup

```bash
cp .env.example .env
npm install
npm start
```

Webhook: `GET/POST /webhook`. Health: `GET /health`.

## Tests

```bash
npm run test:manual
```

Uses stub markers (`{{COPY.xxx}}`), not real content.
