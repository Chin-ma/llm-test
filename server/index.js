import { config } from './config.js';
import { migrate, pool } from './db.js';
import { seedAgent } from './auth.js';
import { startDraftSweeper } from './drafts.js';
import { app } from './app.js';
import { log } from './log.js';

await migrate();
await seedAgent();
const sweeper = startDraftSweeper();
if (!config.llm.apiKey) log('error', 'LLM_API_KEY not set: drafts will fail and agents will see a manual-reply notice');

const server = app.listen(config.port, () => log('info', `listening on :${config.port}`));
const shutdown = () => { clearInterval(sweeper); server.close(() => pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
