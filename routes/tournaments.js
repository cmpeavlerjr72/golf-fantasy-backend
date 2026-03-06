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

// GET /api/tournaments/player-stats
router.get('/player-stats', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('player_stats')
      .select('*')
      .order('dg_rank', { ascending: true, nullsFirst: false });

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

module.exports = router;
