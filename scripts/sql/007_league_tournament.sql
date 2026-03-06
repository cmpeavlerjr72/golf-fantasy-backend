-- Add tournament_id to leagues for pool leagues to reference a specific tournament
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id);
