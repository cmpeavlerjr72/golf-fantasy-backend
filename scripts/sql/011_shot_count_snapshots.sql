-- Snapshot great/poor shot counts on each sync to infer which holes they occurred on
CREATE TABLE IF NOT EXISTS shot_count_snapshots (
  id SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL,
  player_name TEXT NOT NULL,
  round INT,
  thru_hole INT,
  great_shots FLOAT,
  poor_shots FLOAT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shot_snapshots_lookup
  ON shot_count_snapshots(tournament_id, player_name, synced_at DESC);

-- Inferred associations between great/poor shots and specific holes
CREATE TABLE IF NOT EXISTS inferred_shot_holes (
  id SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL,
  player_name TEXT NOT NULL,
  round INT NOT NULL,
  shot_type TEXT NOT NULL,        -- 'great' or 'poor'
  possible_holes INT[] NOT NULL,  -- e.g., {10, 11} if narrowed to 2 holes
  exact BOOLEAN DEFAULT FALSE,    -- true if only 1 possible hole
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inferred_shots_lookup
  ON inferred_shot_holes(tournament_id, player_name);
