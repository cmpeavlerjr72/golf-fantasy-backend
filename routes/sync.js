const express = require('express');
const auth = require('../middleware/auth');
const { syncAll, syncPlayerStats, syncLiveScores, syncTournament, backfillHistoricalTournaments } = require('../services/datagolf');

const router = express.Router();

let lastSync = null;
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minute cooldown

// POST /api/sync — Full sync (tournament + stats + scores)
router.post('/', auth, async (req, res) => {
  if (lastSync && Date.now() - lastSync < COOLDOWN_MS) {
    const secsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastSync)) / 1000);
    return res.status(429).json({ error: `Please wait ${secsLeft}s before syncing again` });
  }

  try {
    lastSync = Date.now();
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// POST /api/sync/scores — Live scores only (lighter, faster)
router.post('/scores', auth, async (req, res) => {
  try {
    const { tournamentId } = await syncTournament();
    const count = await syncLiveScores(tournamentId);
    res.json({ scoresUpdated: count, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Score sync error:', err);
    res.status(500).json({ error: 'Score sync failed: ' + err.message });
  }
});

// POST /api/sync/stats — Player stats only (pre-tournament)
router.post('/stats', auth, async (req, res) => {
  try {
    const count = await syncPlayerStats();
    res.json({ statsUpdated: count, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Stats sync error:', err);
    res.status(500).json({ error: 'Stats sync failed: ' + err.message });
  }
});

// GET /api/sync/debug — Check what data is in the tables
router.get('/debug', auth, async (req, res) => {
  try {
    const supabase = require('../config/supabase');

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id, name, is_active')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) return res.json({ error: 'No active tournament' });

    const { data: tournStats, count: tsCount } = await supabase
      .from('tournament_stats')
      .select('*', { count: 'exact', head: false })
      .eq('tournament_id', tournament.id)
      .limit(3);

    const { data: fieldAvg } = await supabase
      .from('tournament_field_averages')
      .select('*')
      .eq('tournament_id', tournament.id)
      .maybeSingle();

    const { data: holeScores, count: hsCount } = await supabase
      .from('hole_scores')
      .select('player_name', { count: 'exact', head: false })
      .eq('tournament_id', tournament.id)
      .limit(3);

    const { data: lineups } = await supabase
      .from('lineups')
      .select('player_name, slot, member_id')
      .eq('tournament_id', tournament.id)
      .eq('slot', 'starter')
      .limit(10);

    // Check if lineup player names match tournament_stats names
    const starterNames = (lineups || []).map(l => l.player_name);
    const nameMatches = [];
    for (const name of starterNames.slice(0, 5)) {
      const { data: match } = await supabase
        .from('tournament_stats')
        .select('player_name, accuracy, gir, distance')
        .eq('tournament_id', tournament.id)
        .ilike('player_name', name)
        .maybeSingle();
      nameMatches.push({ lineupName: name, foundInStats: !!match, statsName: match?.player_name || null });
    }

    res.json({
      tournament,
      tournamentStats: { count: tsCount, sample: tournStats },
      fieldAverages: fieldAvg,
      holeScores: { count: hsCount, sample: (holeScores || []).map(h => h.player_name) },
      lineupStarters: starterNames,
      nameMatches,
    });
  } catch (err) {
    console.error('Debug error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/finalize-all — Catch up on any missed tournament finalizations
router.post('/finalize-all', auth, async (req, res) => {
  try {
    const supabase = require('../config/supabase');
    const { processWeeklyResults } = require('../services/seasonScoring');

    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const { data: completedTournaments } = await supabase
      .from('tournaments')
      .select('id, name, end_date')
      .eq('is_active', false)
      .lte('end_date', cutoff)
      .order('id', { ascending: false });

    const { data: leagues } = await supabase
      .from('leagues')
      .select('id, name')
      .eq('league_type', 'season')
      .eq('status', 'active');

    const finalized = [];
    for (const tournament of completedTournaments || []) {
      for (const league of leagues || []) {
        const { data: existing } = await supabase
          .from('weekly_results')
          .select('id')
          .eq('league_id', league.id)
          .eq('tournament_id', tournament.id)
          .limit(1);

        if (existing && existing.length > 0) continue;

        const { data: hasScores } = await supabase
          .from('hole_scores')
          .select('id')
          .eq('tournament_id', tournament.id)
          .limit(1);

        if (!hasScores || hasScores.length === 0) continue;

        await processWeeklyResults(league.id, tournament.id);
        finalized.push({ league: league.name, leagueId: league.id, tournament: tournament.name, tournamentId: tournament.id });
      }
    }

    res.json({ finalized, count: finalized.length });
  } catch (err) {
    console.error('Finalize-all error:', err);
    res.status(500).json({ error: 'Finalize-all failed: ' + err.message });
  }
});

// POST /api/sync/backfill — Backfill historical 2026 tournament data from DG
router.post('/backfill', auth, async (req, res) => {
  try {
    console.log('[Backfill] Starting 2026 tournament backfill...');
    const result = await backfillHistoricalTournaments();
    res.json(result);
  } catch (err) {
    console.error('Backfill error:', err);
    res.status(500).json({ error: 'Backfill failed: ' + err.message });
  }
});

module.exports = router;
