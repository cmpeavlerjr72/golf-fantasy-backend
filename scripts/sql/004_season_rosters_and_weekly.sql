-- Fantasy Golf - Season rosters, transactions, trades, weekly results, tee times
-- Run this after 003_league_types_and_lineups.sql

-- Current roster (evolves via draft + add/drops + trades)
CREATE TABLE IF NOT EXISTS rosters (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES league_members(id) ON DELETE CASCADE,
  player_name VARCHAR(255) NOT NULL,
  dg_id INTEGER,
  acquired_via VARCHAR(20) DEFAULT 'draft',
  acquired_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, member_id, player_name)
);

-- Transaction history (add/drop log)
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES league_members(id),
  type VARCHAR(20) NOT NULL,
  player_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Trade proposals
CREATE TABLE IF NOT EXISTS trade_proposals (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  proposer_id INTEGER REFERENCES league_members(id),
  proposer_player VARCHAR(255) NOT NULL,
  target_id INTEGER REFERENCES league_members(id),
  target_player VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Weekly results (fantasy points + season points per manager per tournament)
CREATE TABLE IF NOT EXISTS weekly_results (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id INTEGER REFERENCES tournaments(id),
  member_id INTEGER REFERENCES league_members(id),
  weekly_points DECIMAL(8,2) DEFAULT 0,
  position INTEGER,
  season_points DECIMAL(8,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, tournament_id, member_id)
);

-- Player tee times (from DataGolf field data, used for lock logic)
CREATE TABLE IF NOT EXISTS tee_times (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  player_name VARCHAR(255) NOT NULL,
  dg_id INTEGER,
  round_num INTEGER NOT NULL,
  tee_time TIMESTAMP NOT NULL,
  UNIQUE(tournament_id, player_name, round_num)
);

-- Add season_points_config to leagues for FedEx-style points distribution
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_points_config JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_rosters_league ON rosters(league_id, member_id);
CREATE INDEX IF NOT EXISTS idx_rosters_player ON rosters(league_id, player_name);
CREATE INDEX IF NOT EXISTS idx_transactions_league ON transactions(league_id);
CREATE INDEX IF NOT EXISTS idx_trade_proposals_league ON trade_proposals(league_id);
CREATE INDEX IF NOT EXISTS idx_weekly_results_league ON weekly_results(league_id);
CREATE INDEX IF NOT EXISTS idx_tee_times_tournament ON tee_times(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tee_times_player ON tee_times(tournament_id, player_name);
