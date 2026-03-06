const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');
const { isPlayerLocked } = require('../services/seasonScoring');

const router = express.Router();

// Helper: get member + league or return error
async function getMemberAndLeague(req, res) {
  const { data: league } = await supabase
    .from('leagues')
    .select('*')
    .eq('id', req.params.leagueId)
    .maybeSingle();

  if (!league) { res.status(404).json({ error: 'League not found' }); return null; }
  if (league.league_type !== 'season') { res.status(400).json({ error: 'Only for season leagues' }); return null; }

  const { data: member } = await supabase
    .from('league_members')
    .select('id')
    .eq('league_id', league.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!member) { res.status(403).json({ error: 'Not a member' }); return null; }

  return { league, member };
}

// GET /api/rosters/:leagueId — Get my current roster
router.get('/:leagueId', auth, async (req, res) => {
  try {
    const ctx = await getMemberAndLeague(req, res);
    if (!ctx) return;

    const { data: roster } = await supabase
      .from('rosters')
      .select('*')
      .eq('league_id', ctx.league.id)
      .eq('member_id', ctx.member.id)
      .order('acquired_at');

    // Check lock status for each player
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    const players = [];
    for (const r of roster || []) {
      let locked = false;
      if (tournament) {
        locked = await isPlayerLocked(tournament.id, r.player_name);
      }
      players.push({
        playerName: r.player_name,
        dgId: r.dg_id,
        acquiredVia: r.acquired_via,
        acquiredAt: r.acquired_at,
        locked,
      });
    }

    res.json({ roster: players, rosterSize: ctx.league.roster_size });
  } catch (err) {
    console.error('Get roster error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/rosters/:leagueId/free-agents — Available players not on any roster
router.get('/:leagueId/free-agents', auth, async (req, res) => {
  try {
    const ctx = await getMemberAndLeague(req, res);
    if (!ctx) return;

    // Get all rostered players in this league
    const { data: rostered } = await supabase
      .from('rosters')
      .select('player_name')
      .eq('league_id', ctx.league.id);

    const rosteredNames = new Set((rostered || []).map(r => r.player_name.toLowerCase()));

    // Get all players from player_stats
    const { data: allPlayers } = await supabase
      .from('player_stats')
      .select('player_name, owgr_rank, dg_rank, sg_total')
      .order('dg_rank', { ascending: true, nullsFirst: false });

    // Check lock status
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    const freeAgents = [];
    for (const p of allPlayers || []) {
      if (rosteredNames.has(p.player_name.toLowerCase())) continue;

      let locked = false;
      if (tournament) {
        locked = await isPlayerLocked(tournament.id, p.player_name);
      }

      freeAgents.push({
        playerName: p.player_name,
        owgrRank: p.owgr_rank,
        dgRank: p.dg_rank,
        sgTotal: parseFloat(p.sg_total),
        locked,
      });
    }

    res.json({ freeAgents });
  } catch (err) {
    console.error('Free agents error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/rosters/:leagueId/add — Add a free agent
router.post('/:leagueId/add', auth, async (req, res) => {
  const { playerName } = req.body;
  if (!playerName) return res.status(400).json({ error: 'Player name is required' });

  try {
    const ctx = await getMemberAndLeague(req, res);
    if (!ctx) return;

    // Check roster size
    const { data: roster } = await supabase
      .from('rosters')
      .select('id')
      .eq('league_id', ctx.league.id)
      .eq('member_id', ctx.member.id);

    if ((roster || []).length >= ctx.league.roster_size) {
      return res.status(400).json({ error: 'Roster is full. Drop a player first.' });
    }

    // Check if player is on another roster
    const { data: taken } = await supabase
      .from('rosters')
      .select('id')
      .eq('league_id', ctx.league.id)
      .ilike('player_name', playerName)
      .maybeSingle();

    if (taken) return res.status(409).json({ error: 'Player is already rostered' });

    // Check tee time lock
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (tournament) {
      const locked = await isPlayerLocked(tournament.id, playerName);
      if (locked) return res.status(400).json({ error: 'Player is locked (tee time has passed)' });
    }

    // Add to roster
    const { error } = await supabase
      .from('rosters')
      .insert({
        league_id: ctx.league.id,
        member_id: ctx.member.id,
        player_name: playerName,
        acquired_via: 'add',
      });
    if (error) throw error;

    // Log transaction
    await supabase.from('transactions').insert({
      league_id: ctx.league.id,
      member_id: ctx.member.id,
      type: 'add',
      player_name: playerName,
    });

    res.json({ message: `Added ${playerName}` });
  } catch (err) {
    console.error('Add player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/rosters/:leagueId/drop — Drop a player
router.post('/:leagueId/drop', auth, async (req, res) => {
  const { playerName } = req.body;
  if (!playerName) return res.status(400).json({ error: 'Player name is required' });

  try {
    const ctx = await getMemberAndLeague(req, res);
    if (!ctx) return;

    // Check tee time lock
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (tournament) {
      const locked = await isPlayerLocked(tournament.id, playerName);
      if (locked) return res.status(400).json({ error: 'Player is locked (tee time has passed)' });
    }

    // Remove from roster
    const { error } = await supabase
      .from('rosters')
      .delete()
      .eq('league_id', ctx.league.id)
      .eq('member_id', ctx.member.id)
      .ilike('player_name', playerName);
    if (error) throw error;

    // Also remove from any active lineup
    if (tournament) {
      await supabase
        .from('lineups')
        .delete()
        .eq('league_id', ctx.league.id)
        .eq('member_id', ctx.member.id)
        .eq('tournament_id', tournament.id)
        .ilike('player_name', playerName);
    }

    // Log transaction
    await supabase.from('transactions').insert({
      league_id: ctx.league.id,
      member_id: ctx.member.id,
      type: 'drop',
      player_name: playerName,
    });

    res.json({ message: `Dropped ${playerName}` });
  } catch (err) {
    console.error('Drop player error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/rosters/:leagueId/transactions — Transaction history
router.get('/:leagueId/transactions', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('*, league_members(team_name)')
      .eq('league_id', req.params.leagueId)
      .order('created_at', { ascending: false })
      .limit(50);

    res.json((data || []).map(t => ({
      type: t.type,
      playerName: t.player_name,
      teamName: t.league_members?.team_name,
      date: t.created_at,
    })));
  } catch (err) {
    console.error('Transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
