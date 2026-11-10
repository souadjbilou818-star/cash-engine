-- Only if you deployed v1 before. Fresh installs: schema.sql already has these.
-- npx wrangler d1 execute cash-engine --remote --file=migrations/002_autonomy.sql
ALTER TABLE leads ADD COLUMN source TEXT;
ALTER TABLE leads ADD COLUMN opened_on TEXT;
ALTER TABLE leads ADD COLUMN email_step INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN last_email_at INTEGER;
ALTER TABLE leads ADD COLUMN email_msgid TEXT;
ALTER TABLE leads ADD COLUMN chats INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN paid_at INTEGER;
ALTER TABLE leads ADD COLUMN stripe_customer TEXT;
ALTER TABLE leads ADD COLUMN client_email TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(stripe_customer);
