-- Add primary_tour column to player_stats for filtering PGA vs LIV
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS primary_tour VARCHAR(20);
