import 'dotenv/config';

const required = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  brandId: process.env.BRAND_ID || 'verdant-co',
  webhookSecret: process.env.WEBHOOK_SECRET || 'verdant-demo-secret-2026',
  jwtSecret: required('JWT_SECRET'),
  agentEmail: process.env.AGENT_EMAIL,
  agentPassword: process.env.AGENT_PASSWORD,
  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 20000),
  },
  maxMessageChars: 2000,
};
