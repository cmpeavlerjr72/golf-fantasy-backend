-- Master table: league-agnostic per-player results per tournament
-- Stores raw hole counts + raw stat values, snapshotted at tournament finalization
-- Any league can apply its own scoring multipliers to calculate points on the fly

CREATE TABLE IF NOT EXISTS player_tournament_results (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  player_name VARCHAR(255) NOT NULL,

  -- Hole-by-hole raw counts
  eagles INTEGER DEFAULT 0,
  birdies INTEGER DEFAULT 0,
  pars INTEGER DEFAULT 0,
  bogeys INTEGER DEFAULT 0,
  doubles_or_worse INTEGER DEFAULT 0,
  holes_played INTEGER DEFAULT 0,

  -- Raw stat values (snapshotted from tournament_stats)
  accuracy DECIMAL(6,4),           -- FIR (0-1)
  gir DECIMAL(6,4),                -- Greens in regulation (0-1)
  distance DECIMAL(6,2),           -- Driving distance (yards)
  great_shots DECIMAL(6,1),        -- Count of great shots
  poor_shots DECIMAL(6,1),         -- Count of poor shots

  -- Field averages at time of snapshot (for relative scoring)
  field_avg_accuracy DECIMAL(6,4),
  field_avg_gir DECIMAL(6,4),
  field_avg_distance DECIMAL(6,2),

  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, player_name)
);

CREATE INDEX IF NOT EXISTS idx_player_tournament_results_tournament
  ON player_tournament_results(tournament_id);
CREATE INDEX IF NOT EXISTS idx_player_tournament_results_player
  ON player_tournament_results(tournament_id, player_name);
