import { tx } from './db.js';
import { generateDraft } from './drafts.js';
import { log } from './log.js';

/**
 * The single entry point for an inbound customer message. Both the webhook and the
 * Customer view call this, so they are handled identically.
 *
 * Everything the agent needs (customer, conversation, message, and a 'pending' draft
 * row) is committed in ONE transaction. The slow LLM call happens afterwards, so a
 * failing or slow LLM can never lose a customer message.
 * Idempotent on `message.id`: a retried delivery is a no-op.
 */
export async function ingestCustomerMessage({ brandId, customer, message }) {
  const result = await tx(async (db) => {
    await db.query(
      `INSERT INTO customers (brand_id, id, name, phone) VALUES ($1,$2,$3,$4)
       ON CONFLICT (brand_id, id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone`,
      [brandId, customer.id, customer.name, customer.phone],
    );
    await db.query(
      `INSERT INTO conversations (brand_id, customer_id) VALUES ($1,$2)
       ON CONFLICT (brand_id, customer_id) WHERE status = 'open' DO NOTHING`,
      [brandId, customer.id],
    );
    const { rows: [conv] } = await db.query(
      `SELECT id FROM conversations WHERE brand_id=$1 AND customer_id=$2 AND status='open'`,
      [brandId, customer.id],
    );
    const { rows: [msg] } = await db.query(
      `INSERT INTO messages (conversation_id, external_id, sender, text)
       VALUES ($1,$2,'customer',$3) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [conv.id, message.id, message.text],
    );
    if (!msg) return { duplicate: true, conversationId: conv.id };
    await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conv.id]);
    const { rows: [draft] } = await db.query(
      `INSERT INTO drafts (message_id, conversation_id) VALUES ($1,$2) RETURNING id`,
      [msg.id, conv.id],
    );
    return { duplicate: false, conversationId: conv.id, messageId: msg.id, draftId: draft.id };
  });

  if (!result.duplicate) {
    // Fire and forget; failures are recorded on the draft row and retried by the sweeper.
    generateDraft(result.draftId).catch((e) =>
      log('error', 'draft generation crashed', { draftId: result.draftId, error: e.message }));
  }
  return result;
}
