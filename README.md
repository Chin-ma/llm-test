# Verdant & Co support assistant

Live app: [YOUR LIVE URL]  |  Webhook: [YOUR LIVE URL]/webhook
Agent login: [EMAIL] / [PASSWORD]

Customers send messages, an LLM drafts a reply from the knowledge base, and a support agent edits and approves it.

## Stack and why
Node/Express, PostgreSQL (Supabase) with plain `pg`, and React (Vite). Express also serves the built React app, so I only have one thing to deploy. I know Node best and wanted to spend the time on the behaviour, not on setup. The LLM is OpenRouter's free tier, called through the OpenAI-style API, so switching provider is just env vars.

## Run locally
```bash
cp .env.example .env     # fill DATABASE_URL, LLM_API_KEY, AGENT_EMAIL, AGENT_PASSWORD, JWT_SECRET
npm install
npm run build
npm start                # http://localhost:3000
```
The tables and the agent account are created automatically on start. `npm test` runs the backend tests (embedded Postgres, fake LLM, no keys needed).

Webhook test:
```bash
BODY='{"event_id":"evt_1","type":"message.received","brand_id":"verdant-co","timestamp":"2026-11-03T10:15:22Z","customer":{"id":"cust_1042","name":"Aisha Khan","phone":"+919800000001"},"message":{"id":"msg_1","type":"text","text":"What is your return policy?"}}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac verdant-demo-secret-2026 | sed 's/^.* //')
curl -X POST $URL/webhook -H "content-type: application/json" -H "X-Signature: sha256=$SIG" -d "$BODY"
```

## Main decisions
- **Save the message before calling the AI.** The webhook stores the customer, conversation, message and an empty draft in one transaction, then returns 200. The LLM call happens after. If the LLM is down, the message is still there. The draft is retried up to 3 times, then the agent sees "write it yourself" with an empty box.
- **Safe to retry.** The signature is checked on the raw body. Each `message.id` is unique, so a redelivery does nothing. A database index allows only one open conversation per customer, even if two messages arrive at the same time. Every webhook is logged in `webhook_events`.
- **Approve can only happen once.** The draft row is locked, so a double click or two agents can't send two replies.
- **AI behaviour.** The knowledge base is short, so all of it goes in the prompt and I skipped retrieval. The model is told to use only the knowledge base, not to pretend it can see orders, and to say it can't confirm when the answer isn't there (for example Dubai). Health issues such as the allergy message get "stop using it and see a doctor", with no medical advice. Both cases are marked "needs a human look" for the agent. This approach stops working when the knowledge base gets too big for the prompt, or when entries start to conflict. Then I'd use embeddings.
- **Customer view has no sign-in**, as the task says. That means anyone with a customer id can read that conversation, so it's a test tool only.

## What I left out
Websockets (the UI polls every 3 seconds), a real job queue (a Postgres sweeper retries drafts instead), closing conversations, UI tests, multiple brands, and a fallback model for when the free model is rate limited.

## AI use
I used Claude to scaffold the server, schema, UI and tests, then ran and tested everything and fixed problems as they came up. Where it went wrong: [REPLACE WITH YOUR OWN, e.g. it pinned an `embedded-postgres` version that doesn't exist, so `npm install` failed. Its first build script would also have failed on Render because dev dependencies are skipped in production.]

## Questions
**1. A message arrives at 2 a.m. and something fails.** If the database is up, the message is already saved, so the agent sees it in the morning with either a draft or a "write it yourself" notice. The draft is never silently missing. If the webhook itself failed, it returned a 5xx so the chat system retries. The attempt is in `webhook_events`, and failed drafts keep their error in `drafts.error`. I'd also look at the JSON logs, and add error alerts so we know before the agent does.

**2. This now has to serve 20 brands.** I'd start with data isolation. Every table already has a `brand_id`, so I'd enforce it with Postgres row-level security, and give each brand its own webhook secret and agents. Next I'd move the knowledge base into a per-brand table, since it's the main thing that differs. Then I'd put drafting on a proper queue with per-brand limits, so one brand can't use up the LLM capacity for the others.
