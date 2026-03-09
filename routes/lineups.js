const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/lineups/:leagueId — Get my lineup for the active tournament
router.get('/:leagueId', auth, async (req, res) => {
  try {
    const { data: member } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', req.params.leagueId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this league' });
    }

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id, name')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) {
      return res.json({ tournament: null, lineup: [], roster: [] });
    }

    const { data: lineup } = await supabase
      .from('lineups')
      .select('*')
      .eq('league_id', req.params.leagueId)
      .eq('member_id', member.id)
      .eq('tournament_id', tournament.id);

    // Also return the member's roster so frontend knows all available players
    const { data: rosterData } = await supabase
      .from('rosters')
      .select('player_name')
      .eq('league_id', req.params.leagueId)
      .eq('member_id', member.id);

    res.json({
      tournament,
      lineup: (lineup || []).map(l => ({
        playerName: l.player_name,
        slot: l.slot,
        locked: l.locked,
      })),
      roster: (rosterData || []).map(r => r.player_name),
    });
  } catch (err) {
    console.error('Get lineup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/lineups/:leagueId — Set lineup for the active tournament
router.put('/:leagueId', auth, async (req, res) => {
  const { starters, bench } = req.body;

  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Lineup management is only for season leagues' });
    }

    const { data: member } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this league' });
    }

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) {
      return res.status(400).json({ error: 'No active tournament' });
    }

    // Validate: starters + bench must be on this member's roster
    const { data: rosterData } = await supabase
      .from('rosters')
      .select('player_name')
      .eq('league_id', league.id)
      .eq('member_id', member.id);

    const roster = new Set((rosterData || []).map(p => p.player_name.toLowerCase()));
    const allPlayers = [...(starters || []), ...(bench || [])];

    for (const name of allPlayers) {
      if (!roster.has(name.toLowerCase())) {
        return res.status(400).json({ error: `${name} is not on your roster` });
      }
    }

    if ((starters || []).length > league.starters_count) {
      return res.status(400).json({ error: `Max ${league.starters_count} starters allowed` });
    }

    // Check if lineup is locked (tournament has started for these players)
    const { data: existingLocked } = await supabase
      .from('lineups')
      .select('player_name')
      .eq('league_id', league.id)
      .eq('member_id', member.id)
      .eq('tournament_id', tournament.id)
      .eq('locked', true);

    // Clear and re-insert lineup (only unlocked ones)
    await supabase
      .from('lineups')
      .delete()
      .eq('league_id', league.id)
      .eq('member_id', member.id)
      .eq('tournament_id', tournament.id)
      .eq('locked', false);

    const rows = [];
    for (const name of starters || []) {
      rows.push({
        league_id: league.id,
        member_id: member.id,
        tournament_id: tournament.id,
        player_name: name,
        slot: 'starter',
      });
    }
    for (const name of bench || []) {
      rows.push({
        league_id: league.id,
        member_id: member.id,
        tournament_id: tournament.id,
        player_name: name,
        slot: 'bench',
      });
    }

    if (rows.length > 0) {
      const { error } = await supabase.from('lineups').upsert(rows, {
        onConflict: 'league_id,member_id,tournament_id,player_name',
      });
      if (error) throw error;
    }

    res.json({ message: 'Lineup updated' });
  } catch (err) {
    console.error('Set lineup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lineups/:leagueId/weekly-scores — Live weekly fantasy scores for all teams
router.get('/:leagueId/weekly-scores', auth, async (req, res) => {
  try {
    const { calculatePlayerPointsBatch } = require('../services/seasonScoring');

    const [{ data: league }, { data: tournament }] = await Promise.all([
      supabase.from('leagues').select('*').eq('id', req.params.leagueId).maybeSingle(),
      supabase.from('tournaments').select('id, name').eq('is_active', true).maybeSingle(),
    ]);

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Season league only' });
    }
    if (!tournament) {
      return res.json({ tournament: null, teams: [] });
    }

    const [{ data: members }, { data: allLineups }] = await Promise.all([
      supabase.from('league_members').select('id, team_name, user_id, users(display_name)').eq('league_id', league.id),
      supabase.from('lineups').select('member_id, player_name, slot').eq('league_id', league.id).eq('tournament_id', tournament.id),
    ]);

    // Collect all starter names and batch-calculate in 3 DB queries total
    const allStarterNames = (allLineups || [])
      .filter(l => l.slot === 'starter')
      .map(l => l.player_name);

    const scoringConfig = league.scoring_config || {};
    const pointsMap = allStarterNames.length > 0
      ? await calculatePlayerPointsBatch(tournament.id, allStarterNames, scoringConfig)
      : {};

    const teams = (members || []).map(member => {
      const memberLineup = (allLineups || []).filter(l => l.member_id === member.id);
      const starters = memberLineup.filter(l => l.slot === 'starter');
      const benchPlayers = memberLineup.filter(l => l.slot === 'bench');

      let teamPoints = 0, teamHolePoints = 0, teamStatPoints = 0;
      const players = [];

      for (const starter of starters) {
        const calc = pointsMap[starter.player_name] || { points: 0, hole_points: 0, stat_points: 0, holes_played: 0 };
        teamPoints += calc.points;
        teamHolePoints += calc.hole_points;
        teamStatPoints += calc.stat_points;
        players.push({ playerName: starter.player_name, slot: 'starter', ...calc });
      }

      for (const bp of benchPlayers) {
        players.push({ playerName: bp.player_name, slot: 'bench', points: 0, hole_points: 0, stat_points: 0, holes_played: 0 });
      }

      return {
        memberId: member.id,
        teamName: member.team_name,
        displayName: member.users?.display_name,
        isMe: member.user_id === req.user.id,
        totalPoints: +teamPoints.toFixed(2),
        holePoints: +teamHolePoints.toFixed(2),
        statPoints: +teamStatPoints.toFixed(2),
        players,
      };
    });

    teams.sort((a, b) => b.totalPoints - a.totalPoints);
    res.json({ tournament, teams });
  } catch (err) {
    console.error('Weekly scores error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lineups/:leagueId/season-standings — Season-long points standings
router.get('/:leagueId/season-standings', auth, async (req, res) => {
  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league) {
      return res.status(404).json({ error: 'League not found' });
    }

    const { data: members } = await supabase
      .from('league_members')
      .select('id, team_name, users(display_name)')
      .eq('league_id', league.id);

    const { data: scores } = await supabase
      .from('season_scores')
      .select('*')
      .eq('league_id', league.id);

    const standings = (members || []).map(member => {
      const memberScores = (scores || []).filter(s => s.member_id === member.id);
      const totalPoints = memberScores.reduce((sum, s) => sum + parseFloat(s.points), 0);
      const totalEagles = memberScores.reduce((sum, s) => sum + s.eagles, 0);
      const totalBirdies = memberScores.reduce((sum, s) => sum + s.birdies, 0);
      const totalPars = memberScores.reduce((sum, s) => sum + s.pars, 0);
      const totalBogeys = memberScores.reduce((sum, s) => sum + s.bogeys, 0);
      const tournamentsPlayed = new Set(memberScores.map(s => s.tournament_id)).size;

      return {
        memberId: member.id,
        teamName: member.team_name,
        displayName: member.users?.display_name,
        totalPoints,
        tournamentsPlayed,
        totalEagles,
        totalBirdies,
        totalPars,
        totalBogeys,
      };
    });

    standings.sort((a, b) => b.totalPoints - a.totalPoints);

    res.json({
      leagueName: league.name,
      scoringConfig: league.scoring_config,
      standings,
    });
  } catch (err) {
    console.error('Season standings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/lineups/:leagueId/finalize/:tournamentId — Finalize a tournament week
router.post('/:leagueId/finalize/:tournamentId', auth, async (req, res) => {
  try {
    const { processWeeklyResults } = require('../services/seasonScoring');

    const { data: league } = await supabase
      .from('leagues')
      .select('owner_id, league_type')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Season league only' });
    }

    const results = await processWeeklyResults(
      parseInt(req.params.leagueId),
      parseInt(req.params.tournamentId)
    );

    res.json({ finalized: true, results: results || [] });
  } catch (err) {
    console.error('Finalize week error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lineups/:leagueId/weekly-history — Get all finalized weekly results
router.get('/:leagueId/weekly-history', auth, async (req, res) => {
  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Season league only' });
    }

    const { data: weeklyResults } = await supabase
      .from('weekly_results')
      .select('*, league_members(team_name, users(display_name))')
      .eq('league_id', league.id)
      .order('tournament_id', { ascending: false })
      .order('position');

    // Get tournament names
    const tournamentIds = [...new Set((weeklyResults || []).map(r => r.tournament_id))];
    let tournaments = [];
    if (tournamentIds.length > 0) {
      const { data } = await supabase
        .from('tournaments')
        .select('id, name')
        .in('id', tournamentIds);
      tournaments = data || [];
    }

    const tournamentMap = {};
    for (const t of tournaments) {
      tournamentMap[t.id] = t.name;
    }

    // Group by tournament
    const weeks = {};
    for (const r of weeklyResults || []) {
      if (!weeks[r.tournament_id]) {
        weeks[r.tournament_id] = {
          tournamentId: r.tournament_id,
          tournamentName: tournamentMap[r.tournament_id] || 'Unknown',
          results: [],
        };
      }
      weeks[r.tournament_id].results.push({
        memberId: r.member_id,
        teamName: r.league_members?.team_name,
        displayName: r.league_members?.users?.display_name,
        weeklyPoints: parseFloat(r.weekly_points),
        position: r.position,
        seasonPoints: parseFloat(r.season_points),
      });
    }

    res.json(Object.values(weeks));
  } catch (err) {
    console.error('Weekly history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
