-- Hexmem 2.0 clean baseline. Schema only: no identity, memory, or operator data.

CREATE TABLE identity (
  id INTEGER PRIMARY KEY,
  attribute TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  value_type TEXT DEFAULT 'string',
  public INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_name TEXT,
  description TEXT,
  metadata JSON,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, canonical_name)
);
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_canonical ON entities(canonical_name);

CREATE TABLE entity_aliases (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_type TEXT DEFAULT 'name',
  UNIQUE(alias, alias_type)
);

CREATE TABLE memory_seeds (
  id INTEGER PRIMARY KEY,
  seed_type TEXT NOT NULL,
  seed_text TEXT NOT NULL,
  anchor_facts JSON,
  anchor_entities JSON,
  anchor_values JSON,
  emotional_gist TEXT,
  themes JSON,
  key_tensions TEXT,
  resolution TEXT,
  source_events JSON,
  source_period_id INTEGER,
  time_range_start TEXT,
  time_range_end TEXT,
  original_token_estimate INTEGER,
  seed_token_estimate INTEGER,
  compression_ratio REAL,
  source_table TEXT,
  source_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  subject_entity_id INTEGER REFERENCES entities(id),
  subject_text TEXT,
  predicate TEXT NOT NULL,
  object_entity_id INTEGER REFERENCES entities(id),
  object_text TEXT,
  object_type TEXT DEFAULT 'string',
  confidence REAL DEFAULT 1.0,
  source TEXT,
  source_session TEXT,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  superseded_by INTEGER REFERENCES facts(id),
  emotional_valence REAL DEFAULT 0,
  emotional_arousal REAL DEFAULT 0.3,
  decay_rate REAL DEFAULT 0.1,
  memory_strength REAL DEFAULT 1.0,
  domain TEXT DEFAULT NULL,
  prompt_form TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'private'
    CHECK (sensitivity IN ('public', 'private')),
  consolidation_state TEXT DEFAULT 'active',
  compressed_to_seed_id INTEGER REFERENCES memory_seeds(id),
  repetition_count INTEGER DEFAULT 0,
  next_review_at TEXT,
  last_reviewed_at TEXT,
  retention_estimate REAL DEFAULT 1.0,
  CHECK(subject_entity_id IS NOT NULL OR subject_text IS NOT NULL)
);
CREATE INDEX idx_facts_subject ON facts(subject_entity_id);
CREATE INDEX idx_facts_predicate ON facts(predicate);
CREATE INDEX idx_facts_object ON facts(object_entity_id);
CREATE INDEX idx_facts_sensitivity ON facts(sensitivity);
CREATE INDEX idx_facts_superseded_by ON facts(superseded_by);
CREATE INDEX idx_facts_consolidation ON facts(consolidation_state);
CREATE INDEX idx_facts_next_review ON facts(next_review_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  category TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  significance INTEGER DEFAULT 5,
  entities JSON,
  metadata JSON,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consolidation_state TEXT DEFAULT 'working',
  importance REAL DEFAULT 0.5,
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0,
  decay_rate REAL DEFAULT 0.1,
  compressed_to_seed_id INTEGER REFERENCES memory_seeds(id),
  emotional_valence REAL DEFAULT 0,
  emotional_arousal REAL DEFAULT 0.3,
  emotional_tags JSON,
  repetition_count INTEGER DEFAULT 0,
  next_review_at TEXT,
  last_reviewed_at TEXT,
  memory_strength REAL DEFAULT 1.0,
  retention_estimate REAL DEFAULT 1.0,
  prompt_form TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'private'
    CHECK (sensitivity IN ('public', 'private'))
);
CREATE INDEX idx_events_occurred ON events(occurred_at);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_category ON events(category);
CREATE INDEX idx_events_sensitivity ON events(sensitivity);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  lesson TEXT NOT NULL,
  context TEXT,
  source_event_id INTEGER REFERENCES events(id),
  confidence REAL DEFAULT 0.8,
  times_applied INTEGER DEFAULT 0,
  last_applied_at TEXT,
  times_validated INTEGER DEFAULT 0,
  times_contradicted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  emotional_valence REAL DEFAULT 0,
  emotional_arousal REAL DEFAULT 0.3,
  repetition_count INTEGER DEFAULT 0,
  next_review_at TEXT,
  last_reviewed_at TEXT,
  memory_strength REAL DEFAULT 1.0,
  retention_estimate REAL DEFAULT 1.0,
  valid_until TEXT,
  superseded_by INTEGER REFERENCES lessons(id),
  prompt_form TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'private'
    CHECK (sensitivity IN ('public', 'private')),
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0,
  decay_rate REAL DEFAULT 0.1,
  consolidation_state TEXT DEFAULT 'active',
  compressed_to_seed_id INTEGER REFERENCES memory_seeds(id),
  alpha REAL DEFAULT 1.0,
  beta_param REAL DEFAULT 1.0
);
CREATE INDEX idx_lessons_domain ON lessons(domain);
CREATE INDEX idx_lessons_sensitivity ON lessons(sensitivity);
CREATE INDEX idx_lessons_valid_until ON lessons(valid_until);
CREATE INDEX idx_lessons_superseded_by ON lessons(superseded_by);
CREATE INDEX idx_lessons_consolidation ON lessons(consolidation_state);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('advisory', 'tool_selection', 'session', 'architecture', 'debugging', 'routing')),
  action_type TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  context TEXT,
  lesson_id INTEGER REFERENCES lessons(id),
  outcome TEXT CHECK (outcome IN ('adopted', 'ignored', 'corrected', 'success', 'failure', 'partial')),
  outcome_details TEXT,
  outcome_source TEXT NOT NULL CHECK (outcome_source IN ('explicit', 'implicit', 'review')),
  outcome_weight REAL DEFAULT 1.0,
  confidence_delta REAL,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_observations_lesson ON observations(lesson_id);
CREATE INDEX idx_observations_category ON observations(category);
CREATE INDEX idx_observations_session ON observations(session_id);
CREATE INDEX idx_observations_pending ON observations(outcome) WHERE outcome IS NULL;

CREATE TABLE identity_seeds (
  id INTEGER PRIMARY KEY,
  seed_category TEXT NOT NULL,
  seed_name TEXT NOT NULL UNIQUE,
  seed_text TEXT NOT NULL,
  anchors JSON,
  expands_to TEXT,
  depends_on JSON,
  centrality REAL DEFAULT 0.5,
  load_order INTEGER DEFAULT 50,
  version INTEGER DEFAULT 1,
  previous_version TEXT,
  evolution_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  prompt_form TEXT
);

CREATE TABLE ethics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principle TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'universal'
    CHECK (scope IN ('universal', 'external', 'financial', 'social', 'structural')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  active INTEGER NOT NULL DEFAULT 1,
  rationale TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);

CREATE TABLE domain_sensitivity (
  domain TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL DEFAULT 'private'
    CHECK (sensitivity IN ('public', 'private')),
  PRIMARY KEY (domain, subject)
);

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  retention_before REAL,
  quality INTEGER,
  time_since_last_review_hours REAL,
  notes TEXT
);

CREATE TABLE core_values (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  priority INTEGER DEFAULT 50,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  superseded_by INTEGER REFERENCES core_values(id),
  prompt_form TEXT
);

CREATE TABLE self_schemas (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  description TEXT NOT NULL,
  strength REAL DEFAULT 0.5,
  is_aspirational INTEGER DEFAULT 0,
  UNIQUE(domain, schema_name)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT DEFAULT 'todo',
  status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 5,
  goal_id INTEGER,
  due_at TEXT,
  remind_at TEXT,
  recurrence TEXT,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  verification_criteria TEXT,
  acceptance_status TEXT,
  blocked_by TEXT,
  effort_estimate_minutes INTEGER,
  actual_effort_minutes INTEGER,
  correction_count INTEGER DEFAULT 0,
  related_lesson_ids TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due ON tasks(due_at);

CREATE TABLE narrative_threads (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  thread_type TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  themes JSON,
  initiating_event_id INTEGER REFERENCES events(id),
  current_chapter TEXT,
  imagined_resolution TEXT,
  related_goals JSON,
  related_entities JSON,
  key_events JSON,
  meaning_derived TEXT,
  emotional_valence TEXT,
  started_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meaning_frames (
  id INTEGER PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  frame_type TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  transformation TEXT,
  lesson_derived TEXT,
  lesson_id INTEGER REFERENCES lessons(id),
  initial_valence TEXT,
  current_valence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE priming_state (
  id INTEGER PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id INTEGER,
  item_name TEXT,
  activation_level REAL DEFAULT 1.0,
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT,
  expires_at TEXT
);

CREATE TABLE daily_logs (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'note',
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'hexmem',
  tags TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_daily_logs_day_ts ON daily_logs(day, ts);
CREATE INDEX idx_daily_logs_kind_ts ON daily_logs(kind, ts);

CREATE TABLE relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  strength REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE embedding_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  text_to_embed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  error_message TEXT
);
CREATE INDEX idx_embedding_queue_status ON embedding_queue(status, id);

CREATE VIRTUAL TABLE facts_fts USING fts5(
  subject_text, predicate, object_text, domain,
  content=facts, content_rowid=id
);
CREATE VIRTUAL TABLE events_fts USING fts5(
  summary, details, category, event_type,
  content=events, content_rowid=id
);
CREATE VIRTUAL TABLE lessons_fts USING fts5(
  lesson, context, domain,
  content=lessons, content_rowid=id
);
CREATE VIRTUAL TABLE seeds_fts USING fts5(
  seed_text, emotional_gist, seed_type,
  content=memory_seeds, content_rowid=id
);

CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, subject_text, predicate, object_text, domain)
  VALUES (new.id, COALESCE(new.subject_text,''), new.predicate, COALESCE(new.object_text,''), COALESCE(new.domain,''));
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject_text, predicate, object_text, domain)
  VALUES ('delete', old.id, COALESCE(old.subject_text,''), old.predicate, COALESCE(old.object_text,''), COALESCE(old.domain,''));
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject_text, predicate, object_text, domain)
  VALUES ('delete', old.id, COALESCE(old.subject_text,''), old.predicate, COALESCE(old.object_text,''), COALESCE(old.domain,''));
  INSERT INTO facts_fts(rowid, subject_text, predicate, object_text, domain)
  VALUES (new.id, COALESCE(new.subject_text,''), new.predicate, COALESCE(new.object_text,''), COALESCE(new.domain,''));
END;

CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, summary, details, category, event_type)
  VALUES (new.id, COALESCE(new.summary,''), COALESCE(new.details,''), COALESCE(new.category,''), COALESCE(new.event_type,''));
END;
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, summary, details, category, event_type)
  VALUES ('delete', old.id, COALESCE(old.summary,''), COALESCE(old.details,''), COALESCE(old.category,''), COALESCE(old.event_type,''));
END;
CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, summary, details, category, event_type)
  VALUES ('delete', old.id, COALESCE(old.summary,''), COALESCE(old.details,''), COALESCE(old.category,''), COALESCE(old.event_type,''));
  INSERT INTO events_fts(rowid, summary, details, category, event_type)
  VALUES (new.id, COALESCE(new.summary,''), COALESCE(new.details,''), COALESCE(new.category,''), COALESCE(new.event_type,''));
END;

CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, lesson, context, domain)
  VALUES (new.id, COALESCE(new.lesson,''), COALESCE(new.context,''), COALESCE(new.domain,''));
END;
CREATE TRIGGER lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, lesson, context, domain)
  VALUES ('delete', old.id, COALESCE(old.lesson,''), COALESCE(old.context,''), COALESCE(old.domain,''));
END;
CREATE TRIGGER lessons_au AFTER UPDATE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, lesson, context, domain)
  VALUES ('delete', old.id, COALESCE(old.lesson,''), COALESCE(old.context,''), COALESCE(old.domain,''));
  INSERT INTO lessons_fts(rowid, lesson, context, domain)
  VALUES (new.id, COALESCE(new.lesson,''), COALESCE(new.context,''), COALESCE(new.domain,''));
END;

CREATE TRIGGER seeds_ai AFTER INSERT ON memory_seeds BEGIN
  INSERT INTO seeds_fts(rowid, seed_text, emotional_gist, seed_type)
  VALUES (new.id, COALESCE(new.seed_text,''), COALESCE(new.emotional_gist,''), COALESCE(new.seed_type,''));
END;
CREATE TRIGGER seeds_ad AFTER DELETE ON memory_seeds BEGIN
  INSERT INTO seeds_fts(seeds_fts, rowid, seed_text, emotional_gist, seed_type)
  VALUES ('delete', old.id, COALESCE(old.seed_text,''), COALESCE(old.emotional_gist,''), COALESCE(old.seed_type,''));
END;
CREATE TRIGGER seeds_au AFTER UPDATE ON memory_seeds BEGIN
  INSERT INTO seeds_fts(seeds_fts, rowid, seed_text, emotional_gist, seed_type)
  VALUES ('delete', old.id, COALESCE(old.seed_text,''), COALESCE(old.emotional_gist,''), COALESCE(old.seed_type,''));
  INSERT INTO seeds_fts(rowid, seed_text, emotional_gist, seed_type)
  VALUES (new.id, COALESCE(new.seed_text,''), COALESCE(new.emotional_gist,''), COALESCE(new.seed_type,''));
END;

CREATE VIEW v_active_tasks AS
SELECT id, title, description, status, priority, due_at, context
FROM tasks
WHERE status IN ('pending', 'in_progress');

CREATE VIEW v_memory_lifecycle AS
SELECT 'facts' AS source_table, id AS source_id, domain AS group_name,
       subject_text AS content_preview, consolidation_state, memory_strength,
       last_accessed_at, created_at
FROM facts
UNION ALL
SELECT 'events', id, category, summary, consolidation_state, memory_strength,
       last_accessed_at, created_at
FROM events
UNION ALL
SELECT 'lessons', id, domain, lesson, consolidation_state, memory_strength,
       last_accessed_at, created_at
FROM lessons;
