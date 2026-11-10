-- D1 schema. Apply with:  npx wrangler d1 execute cash-engine --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS leads (
  slug          TEXT PRIMARY KEY,          -- unguessable demo id, e.g. le-petit-zinc-k3f9
  osm_id        TEXT UNIQUE,               -- dedupe key (node/123, way/456)
  name          TEXT NOT NULL,
  category      TEXT,                      -- French label, e.g. "Salon de coiffure"
  cat_key       TEXT,                      -- internal key, e.g. hairdresser
  theme         TEXT,                      -- food | beauty | barber | craft | retail | dark
  kind          TEXT,                      -- no_site | weak_site | skip
  address       TEXT,
  postcode      TEXT,
  city          TEXT,
  lat           REAL,
  lon           REAL,
  phone         TEXT,
  email         TEXT,
  instagram     TEXT,
  facebook      TEXT,
  website       TEXT,                      -- their current site (weak_site leads)
  hours         TEXT,                      -- raw OSM opening_hours
  audit         TEXT,                      -- JSON: pagespeed score, viewport, https...
  content       TEXT,                      -- JSON: site copy + outreach copy
  score         INTEGER DEFAULT 0,         -- lead priority
  status        TEXT DEFAULT 'new',        -- new | contacted | opened | hot | won | lost | optout | skip
  domain        TEXT,                      -- client's own domain once won
  created_at    INTEGER,
  contacted_at  INTEGER,
  expires_at    INTEGER,
  views         INTEGER DEFAULT 0,
  first_view_at INTEGER,
  last_view_at  INTEGER,
  notes         TEXT,
  source        TEXT,                      -- osm | sirene
  opened_on     TEXT,                      -- business opening date (registry), YYYY-MM-DD
  email_step    INTEGER DEFAULT 0,         -- emails sent in the sequence (max 3)
  last_email_at INTEGER,
  email_msgid   TEXT,                      -- Message-ID of the first email, for threading
  chats         INTEGER DEFAULT 0,         -- AI closer messages today-ish (abuse cap)
  paid_at       INTEGER,
  stripe_customer TEXT,
  client_email  TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(stripe_customer);

CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  slug  TEXT,
  type  TEXT,                              -- view | cta_call | cta_claim | claim | optout | chat | email_in | email_out | paid | churn
  at    INTEGER,
  meta  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

-- Phones / emails that asked never to be contacted again. Kept 3 years minimum.
CREATE TABLE IF NOT EXISTS suppress (
  key TEXT PRIMARY KEY,
  at  INTEGER
);
