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

module.exports = router;
