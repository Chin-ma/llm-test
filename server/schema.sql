-- Idempotent schema, applied on every start.
CREATE TABLE IF NOT EXISTS agents (
  id            BIGSERIAL PRIMARY KEY,
  brand_id      TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  brand_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id              BIGSERIAL PRIMARY KEY,
  brand_id        TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (brand_id, customer_id) REFERENCES customers (brand_id, id)
);
-- "Each customer has one open conversation", enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_conversation_per_customer
  ON conversations (brand_id, customer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS conversations_recent
  ON conversations (brand_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations (id),
  external_id     TEXT UNIQUE,          -- sender's message id; makes retries idempotent
  sender          TEXT NOT NULL CHECK (sender IN ('customer','agent')),
  text            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS drafts (
  id              BIGSERIAL PRIMARY KEY,
  message_id      BIGINT NOT NULL UNIQUE REFERENCES messages (id),  -- the customer message it answers
  conversation_id BIGINT NOT NULL REFERENCES conversations (id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','generating','ready','failed','used','superseded')),
  text            TEXT,
  needs_human     BOOLEAN NOT NULL DEFAULT false,   -- AI says a person must look at this
  reason          TEXT,
  error           TEXT,
  model           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  edited          BOOLEAN,                          -- set when approved
  sent_message_id BIGINT REFERENCES messages (id),  -- the agent reply created on approval
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_by_conversation ON drafts (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS drafts_open_work ON drafts (status) WHERE status IN ('pending','generating');

-- Audit log of raw webhook deliveries: lets us see what arrived and what failed.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  brand_id    TEXT,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')),
  error       TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
