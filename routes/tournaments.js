const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');
const cache = require('../services/cache');

const router = express.Router();

// GET /api/tournaments/list — All tournaments (for pool league setup)
router.get('/list', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('id, name, year, status, start_date, end_date, is_active')
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('List tournaments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/:id/field — Players in a specific tournament (from player_scores)
router.get('/:id/field', auth, async (req, res) => {
  try {
    // Get player names from the tournament's player_scores
    const { data: scores, error: scoresErr } = await supabase
      .from('player_scores')
      .select('player_name')
      .eq('tournament_id', req.params.id);

    if (scoresErr) throw scoresErr;

    const fieldNames = (scores || []).map(s => s.player_name);
    if (fieldNames.length === 0) {
      return res.json([]);
    }

    // Join with player_stats for SG/ranking data
    const { data: stats, error: statsErr } = await supabase
      .from('player_stats')
      .select('*')
      .in('player_name', fieldNames)
      .order('dg_rank', { ascending: true, nullsFirst: false });

    if (statsErr) throw statsErr;

    // Include field players who might not be in player_stats
    const statsMap = new Map((stats || []).map(s => [s.player_name.toLowerCase(), s]));
    const result = fieldNames.map(name => {
      const p = statsMap.get(name.toLowerCase());
      return {
        playerName: name,
        owgrRank: p?.owgr_rank || null,
        dgRank: p?.dg_rank || null,
        sgTotal: p ? parseFloat(p.sg_total) : null,
        sgOtt: p ? parseFloat(p.sg_ott) : null,
        sgApp: p ? parseFloat(p.sg_app) : null,
        sgArg: p ? parseFloat(p.sg_arg) : null,
        sgPutt: p ? parseFloat(p.sg_putt) : null,
        drivingAcc: p ? parseFloat(p.driving_acc) : null,
        drivingDist: p ? parseFloat(p.driving_dist) : null,
        winPct: p ? parseFloat(p.win_pct) : null,
        top5Pct: p ? parseFloat(p.top5_pct) : null,
        top10Pct: p ? parseFloat(p.top10_pct) : null,
        top20Pct: p ? parseFloat(p.top20_pct) : null,
      };
    });

    // Sort by dg_rank
    result.sort((a, b) => (a.dgRank || 999) - (b.dgRank || 999));
    res.json(result);
  } catch (err) {
    console.error('Tournament field error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/active
router.get('/active', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Active tournament error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/leaderboard
router.get('/leaderboard', auth, async (req, res) => {
  try {
    const cached = cache.get('leaderboard');
    if (cached) return res.json(cached);

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('*')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) {
      return res.json({ tournament: null, leaderboard: [] });
    }

    const { data: scores, error } = await supabase
      .from('player_scores')
      .select('*')
      .eq('tournament_id', tournament.id)
      .order('score_to_par', { ascending: true, nullsFirst: false });

    if (error) throw error;

    const result = {
      tournament,
      leaderboard: (scores || []).map(s => ({
        playerName: s.player_name,
        position: s.position,
        scoreToPar: s.score_to_par,
        thru: s.thru,
        today: s.today,
        round1: s.round1,
        round2: s.round2,
        round3: s.round3,
        round4: s.round4,
      })),
    };

    cache.set('leaderboard', result, 60_000); // 1 min cache
    res.json(result);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/player-stats?tour=pga
router.get('/player-stats', auth, async (req, res) => {
  try {
    const wantTour = req.query.tour || 'all';
    const cacheKey = `player-stats:${wantTour}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let query = supabase
      .from('player_stats')
      .select('*')
      .order('dg_rank', { ascending: true, nullsFirst: false });

    if (wantTour !== 'all') {
      query = query.eq('primary_tour', wantTour);
    }

    let { data, error } = await query;

    // Fallback: if tour filter returned nothing (column not populated yet), return all
    if (wantTour !== 'all' && (!data || data.length === 0) && !error) {
      const fallback = await supabase
        .from('player_stats')
        .select('*')
        .order('dg_rank', { ascending: true, nullsFirst: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;

    const result = (data || []).map(p => ({
      playerName: p.player_name,
      owgrRank: p.owgr_rank,
      dgRank: p.dg_rank,
      sgTotal: parseFloat(p.sg_total),
      sgOtt: parseFloat(p.sg_ott),
      sgApp: parseFloat(p.sg_app),
      sgArg: parseFloat(p.sg_arg),
      sgPutt: parseFloat(p.sg_putt),
      drivingAcc: parseFloat(p.driving_acc),
      drivingDist: parseFloat(p.driving_dist),
      winPct: parseFloat(p.win_pct),
      top5Pct: parseFloat(p.top5_pct),
      top10Pct: parseFloat(p.top10_pct),
      top20Pct: parseFloat(p.top20_pct),
    }));

    cache.set(cacheKey, result, 5 * 60_000); // 5 min cache
    res.json(result);
  } catch (err) {
    console.error('Player stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/hole-scores?player=Name — Get hole-by-hole for a player
// GET /api/tournaments/hole-scores — Get all hole scores (for league standings expansion)
router.get('/hole-scores', auth, async (req, res) => {
  try {
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) {
      return res.json({ players: [] });
    }

    let query = supabase
      .from('hole_scores')
      .select('player_name, dg_id, round_num, hole, par, score')
      .eq('tournament_id', tournament.id)
      .order('round_num')
      .order('hole');

    if (req.query.player) {
      query = query.ilike('player_name', `%${req.query.player}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Group by player -> rounds -> holes
    const playerMap = new Map();
    for (const row of data || []) {
      if (!playerMap.has(row.player_name)) {
        playerMap.set(row.player_name, { playerName: row.player_name, dgId: row.dg_id, rounds: {} });
      }
      const player = playerMap.get(row.player_name);
      if (!player.rounds[row.round_num]) {
        player.rounds[row.round_num] = [];
      }
      player.rounds[row.round_num].push({
        hole: row.hole,
        par: row.par,
        score: row.score,
      });
    }

    const players = Array.from(playerMap.values()).map(p => ({
      playerName: p.playerName,
      dgId: p.dgId,
      rounds: Object.entries(p.rounds).map(([roundNum, holes]) => ({
        roundNum: parseInt(roundNum),
        holes,
      })),
    }));

    res.json({ players });
  } catch (err) {
    console.error('Hole scores error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
