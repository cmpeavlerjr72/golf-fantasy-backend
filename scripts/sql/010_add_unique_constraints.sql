-- Add unique constraints needed for atomic upserts (replacing delete-then-insert)

-- player_stats: prevent duplicate player entries, enable upsert by player_name
ALTER TABLE player_stats ADD CONSTRAINT player_stats_player_name_key UNIQUE (player_name);

-- player_scores: prevent duplicate score entries per tournament, enable upsert
ALTER TABLE player_scores ADD CONSTRAINT player_scores_tournament_player_key UNIQUE (tournament_id, player_name);
