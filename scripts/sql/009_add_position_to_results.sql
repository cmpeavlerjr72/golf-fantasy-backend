-- Add position column to player_tournament_results for position-based scoring
ALTER TABLE player_tournament_results
  ADD COLUMN IF NOT EXISTS position VARCHAR(10);
