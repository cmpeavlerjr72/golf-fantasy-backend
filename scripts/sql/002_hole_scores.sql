-- Fantasy Golf - Hole-by-hole scoring
-- Run this after 001_initial_tables.sql

CREATE TABLE IF NOT EXISTS hole_scores (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  player_name VARCHAR(255) NOT NULL,
  dg_id INTEGER,
  round_num INTEGER NOT NULL,
  hole INTEGER NOT NULL,
  par INTEGER NOT NULL,
  score INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, player_name, round_num, hole)
);

CREATE INDEX IF NOT EXISTS idx_hole_scores_tournament ON hole_scores(tournament_id);
CREATE INDEX IF NOT EXISTS idx_hole_scores_player ON hole_scores(tournament_id, player_name);
