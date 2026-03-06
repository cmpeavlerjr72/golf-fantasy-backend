-- Fantasy Golf - League types, scoring config, and lineup management
-- Run this after 002_hole_scores.sql

-- Add league type and scoring config to leagues
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS league_type VARCHAR(20) DEFAULT 'pool';
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS scoring_config JSONB DEFAULT '{}';
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS roster_size INTEGER DEFAULT 4;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS starters_count INTEGER DEFAULT 4;

-- Lineup management for season-long leagues
CREATE TABLE IF NOT EXISTS lineups (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES league_members(id) ON DELETE CASCADE,
  tournament_id INTEGER REFERENCES tournaments(id),
  player_name VARCHAR(255) NOT NULL,
  slot VARCHAR(20) NOT NULL DEFAULT 'starter',
  locked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, member_id, tournament_id, player_name)
);

-- Season scoring log (points earned per player per tournament)
CREATE TABLE IF NOT EXISTS season_scores (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES league_members(id) ON DELETE CASCADE,
  tournament_id INTEGER REFERENCES tournaments(id),
  player_name VARCHAR(255) NOT NULL,
  points DECIMAL(8,2) DEFAULT 0,
  eagles INTEGER DEFAULT 0,
  birdies INTEGER DEFAULT 0,
  pars INTEGER DEFAULT 0,
  bogeys INTEGER DEFAULT 0,
  doubles_or_worse INTEGER DEFAULT 0,
  holes_played INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, member_id, tournament_id, player_name)
);

CREATE INDEX IF NOT EXISTS idx_lineups_league ON lineups(league_id, member_id);
CREATE INDEX IF NOT EXISTS idx_lineups_tournament ON lineups(tournament_id);
CREATE INDEX IF NOT EXISTS idx_season_scores_league ON season_scores(league_id);
CREATE INDEX IF NOT EXISTS idx_season_scores_tournament ON season_scores(tournament_id);
