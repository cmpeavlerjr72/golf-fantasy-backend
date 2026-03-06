-- Live tournament stats (from DataGolf live-tournament-stats endpoint)
-- Stores per-player stats + field averages for relative scoring
-- Run this after 004_season_rosters_and_weekly.sql

CREATE TABLE IF NOT EXISTS tournament_stats (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  player_name VARCHAR(255) NOT NULL,
  dg_id INTEGER,
  accuracy DECIMAL(6,4),       -- fairway accuracy (0-1)
  gir DECIMAL(6,4),            -- greens in regulation (0-1)
  distance DECIMAL(6,2),       -- driving distance (yards)
  great_shots DECIMAL(6,1),    -- count of great shots
  poor_shots DECIMAL(6,1),     -- count of poor shots
  sg_putt DECIMAL(6,3),
  sg_arg DECIMAL(6,3),
  sg_app DECIMAL(6,3),
  sg_ott DECIMAL(6,3),
  sg_total DECIMAL(6,3),
  thru VARCHAR(10),
  position VARCHAR(10),
  total_score INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id, player_name)
);

-- Field averages per tournament (recalculated each sync)
CREATE TABLE IF NOT EXISTS tournament_field_averages (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  avg_accuracy DECIMAL(6,4),
  avg_gir DECIMAL(6,4),
  avg_distance DECIMAL(6,2),
  avg_great_shots DECIMAL(6,1),
  avg_poor_shots DECIMAL(6,1),
  player_count INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tournament_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_stats_tournament ON tournament_stats(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_stats_player ON tournament_stats(tournament_id, player_name);
