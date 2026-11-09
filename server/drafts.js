import { pool } from './db.js';
import { draftReply } from './llm.js';
import { log } from './log.js';

const MAX_ATTEMPTS = 3;

/**
 * Generate the AI draft for one draft row. Safe to call repeatedly: only one caller can
 * claim a 'pending' row. On failure the row goes back to 'pending' (retried by the sweeper)
 * until MAX_ATTEMPTS, then 'failed' so the agent sees a clear "write it manually" state.
 */
export async function generateDraft(draftId) {
  const { rows: [claimed] } = await pool.query(
    `UPDATE drafts SET status='generating', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id, conversation_id, message_id, attempts`,
    [draftId],
  );
  if (!claimed) return; // someone else has it, or it is already done

  try {
    const { rows: history } = await pool.query(
      `SELECT sender, text FROM (
         SELECT sender, text, id FROM messages
         WHERE conversation_id = $1 AND id <= $2 ORDER BY id DESC LIMIT 10
       ) t ORDER BY id`,
      [claimed.conversation_id, claimed.message_id],
    );
    const { rows: [cust] } = await pool.query(
      `SELECT c.name FROM customers c JOIN conversations v ON v.brand_id=c.brand_id AND v.customer_id=c.id WHERE v.id=$1`,
      [claimed.conversation_id],
    );
    const out = await draftReply({ customerName: cust.name, history });

    // Only store if still generating: the agent may have answered manually in the meantime.
    await pool.query(
      `UPDATE drafts SET status='ready', text=$2, needs_human=$3, reason=$4, model=$5, error=NULL, updated_at=now()
       WHERE id=$1 AND status='generating'`,
      [draftId, out.reply, out.needsHuman, out.reason, out.model],
    );
    log('info', 'draft ready', { draftId, needsHuman: out.needsHuman, model: out.model });
  } catch (e) {
    const final = claimed.attempts >= MAX_ATTEMPTS;
    await pool.query(
      `UPDATE drafts SET status=$2, error=$3, updated_at=now() WHERE id=$1 AND status='generating'`,
      [draftId, final ? 'failed' : 'pending', String(e.message).slice(0, 500)],
    );
    log('error', 'draft generation failed', { draftId, attempt: claimed.attempts, final, error: e.message });
  }
}

/** Reset a failed/ready draft so the agent can ask for a fresh AI suggestion. */
export async function regenerateDraft(draftId) {
  const { rowCount } = await pool.query(
    `UPDATE drafts SET status='pending', attempts=0, error=NULL, updated_at=now()
     WHERE id=$1 AND status IN ('failed','ready')`,
    [draftId],
  );
  if (rowCount) await generateDraft(draftId);
  return rowCount > 0;
}

/** Background recovery: picks up drafts left pending (retry) or stuck generating (server crashed mid-call). */
export function startDraftSweeper(intervalMs = 20000) {
  const tick = async () => {
    try {
      await pool.query(
        `UPDATE drafts SET status='pending', updated_at=now()
         WHERE status='generating' AND updated_at < now() - interval '2 minutes'`,
      );
      const { rows } = await pool.query(
        `SELECT id FROM drafts WHERE status='pending' AND updated_at < now() - interval '15 seconds'
         ORDER BY id LIMIT 20`,
      );
      for (const r of rows) await generateDraft(r.id);
    } catch (e) {
      log('error', 'draft sweeper error', { error: e.message });
    }
  };
  tick(); // recover work left from before a restart
  return setInterval(tick, intervalMs);
}
