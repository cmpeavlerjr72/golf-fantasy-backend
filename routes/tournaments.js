const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

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

    res.json({
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
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tournaments/player-stats?tour=pga
router.get('/player-stats', auth, async (req, res) => {
  try {
    let query = supabase
      .from('player_stats')
      .select('*')
      .order('dg_rank', { ascending: true, nullsFirst: false });

    if (req.query.tour) {
      query = query.eq('primary_tour', req.query.tour);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json((data || []).map(p => ({
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
    })));
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
