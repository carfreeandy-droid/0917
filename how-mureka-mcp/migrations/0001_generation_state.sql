CREATE TABLE IF NOT EXISTS generation_requests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  prepared_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  expires_at INTEGER NOT NULL,
  title TEXT,
  generation_type TEXT NOT NULL CHECK (generation_type IN ('song', 'instrumental')),
  model TEXT NOT NULL,
  lyrics TEXT,
  prompt TEXT,
  parameters_json TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'submitting', 'running', 'succeeded', 'failed', 'expired')),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('pending', 'executing', 'used', 'expired')),
  mureka_task_id TEXT UNIQUE,
  before_balance_cents INTEGER,
  after_balance_cents INTEGER,
  actual_spending_cents INTEGER,
  result_url TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS generation_requests_mureka_task_id_idx
  ON generation_requests(mureka_task_id);

CREATE INDEX IF NOT EXISTS generation_requests_expires_at_idx
  ON generation_requests(expires_at);
