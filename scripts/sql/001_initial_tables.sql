-- Fantasy Golf - Initial Schema
-- Run this first in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leagues (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  invite_code VARCHAR(8) UNIQUE NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  max_teams INTEGER NOT NULL DEFAULT 8,
  scoring_top_n INTEGER NOT NULL DEFAULT 4,
  draft_rounds INTEGER NOT NULL DEFAULT 4,
  status VARCHAR(20) DEFAULT 'pre_draft',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS league_members (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  team_name VARCHAR(100) NOT NULL,
  draft_order INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, user_id)
);

CREATE TABLE IF NOT EXISTS draft_picks (
  id SERIAL PRIMARY KEY,
  league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES league_members(id),
  player_name VARCHAR(255) NOT NULL,
  player_id VARCHAR(100),
  round INTEGER NOT NULL,
  pick_number INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(league_id, pick_number)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  year INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'upcoming',
  start_date DATE,
  end_date DATE,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_scores (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id),
  player_name VARCHAR(255) NOT NULL,
  position VARCHAR(10),
  score_to_par INTEGER,
  thru VARCHAR(10),
  today INTEGER,
  round1 INTEGER,
  round2 INTEGER,
  round3 INTEGER,
  round4 INTEGER,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_stats (
  id SERIAL PRIMARY KEY,
  player_name VARCHAR(255) NOT NULL,
  owgr_rank INTEGER,
  dg_rank INTEGER,
  sg_total DECIMAL(5,2),
  sg_ott DECIMAL(5,2),
  sg_app DECIMAL(5,2),
  sg_arg DECIMAL(5,2),
  sg_putt DECIMAL(5,2),
  driving_acc DECIMAL(5,2),
  driving_dist DECIMAL(5,1),
  win_pct DECIMAL(5,2),
  top5_pct DECIMAL(5,2),
  top10_pct DECIMAL(5,2),
  top20_pct DECIMAL(5,2),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_members_league ON league_members(league_id);
CREATE INDEX IF NOT EXISTS idx_draft_picks_league ON draft_picks(league_id);
CREATE INDEX IF NOT EXISTS idx_player_scores_tournament ON player_scores(tournament_id);
