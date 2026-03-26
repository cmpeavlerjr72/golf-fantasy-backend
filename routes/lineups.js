const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');
const cache = require('../services/cache');

const router = express.Router();

// GET /api/lineups/:leagueId — Get my lineup for the active tournament
// Accepts optional ?tournament_id= to pin to a specific tournament
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

    let tournament;
    if (req.query.tournament_id) {
      const { data } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('id', req.query.tournament_id)
        .maybeSingle();
      tournament = data;
    } else {
      const { data } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('is_active', true)
        .maybeSingle();
      tournament = data;
    }

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

    // Get tournament field to show in-field status
    const { data: teeTimes } = await supabase
      .from('tee_times')
      .select('player_name')
      .eq('tournament_id', tournament.id)
      .eq('round_num', 1);

    const fieldSet = new Set();
    for (const tt of teeTimes || []) {
      fieldSet.add(tt.player_name.toLowerCase());
    }

    res.json({
      tournament,
      tournamentId: tournament.id,
      lineup: (lineup || []).map(l => ({
        playerName: l.player_name,
        slot: l.slot,
        locked: l.locked,
        inField: fieldSet.has(l.player_name.toLowerCase()),
      })),
      roster: (rosterData || []).map(r => r.player_name),
    });
  } catch (err) {
    console.error('Get lineup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/lineups/:leagueId — Set lineup for the active tournament
// Accepts optional tournament_id in body to pin to a specific tournament
router.put('/:leagueId', auth, async (req, res) => {
  const { starters, bench, tournament_id } = req.body;

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

    let tournament;
    if (tournament_id) {
      const { data } = await supabase
        .from('tournaments')
        .select('id')
        .eq('id', tournament_id)
        .maybeSingle();
      tournament = data;
    } else {
      const { data } = await supabase
        .from('tournaments')
        .select('id')
        .eq('is_active', true)
        .maybeSingle();
      tournament = data;
    }

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

// POST /api/lineups/admin/set — Manually set lineups for a specific tournament
// Body: { league_id, tournament_id, lineups: [{ member_id, starters: [...], bench: [...] }] }
// Secured with ADMIN_SECRET header
router.post('/admin/set', async (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { league_id, tournament_id, lineups } = req.body;

  if (!league_id || !tournament_id || !Array.isArray(lineups)) {
    return res.status(400).json({ error: 'Required: league_id, tournament_id, lineups[]' });
  }

  try {
    // Verify tournament exists
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id, name')
      .eq('id', tournament_id)
      .maybeSingle();

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const results = [];

    for (const entry of lineups) {
      const { member_id, starters, bench } = entry;
      if (!member_id) {
        results.push({ member_id, error: 'Missing member_id' });
        continue;
      }

      // Clear existing unlocked lineup for this member/tournament
      await supabase
        .from('lineups')
        .delete()
        .eq('league_id', league_id)
        .eq('member_id', member_id)
        .eq('tournament_id', tournament_id)
        .eq('locked', false);

      const rows = [];
      for (const name of starters || []) {
        rows.push({
          league_id,
          member_id,
          tournament_id,
          player_name: name,
          slot: 'starter',
        });
      }
      for (const name of bench || []) {
        rows.push({
          league_id,
          member_id,
          tournament_id,
          player_name: name,
          slot: 'bench',
        });
      }

      if (rows.length > 0) {
        const { error } = await supabase.from('lineups').upsert(rows, {
          onConflict: 'league_id,member_id,tournament_id,player_name',
        });
        if (error) {
          results.push({ member_id, error: error.message });
          continue;
        }
      }

      results.push({ member_id, starters: (starters || []).length, bench: (bench || []).length, ok: true });
    }

    console.log(`[Admin] Set lineups for league ${league_id}, tournament "${tournament.name}" (${tournament_id}): ${results.filter(r => r.ok).length}/${lineups.length} succeeded`);
    res.json({ tournament: tournament.name, results });
  } catch (err) {
    console.error('Admin set lineup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lineups/:leagueId/weekly-scores — Live weekly fantasy scores for all teams
router.get('/:leagueId/weekly-scores', auth, async (req, res) => {
  try {
    const { calculatePlayerPointsBatch } = require('../services/seasonScoring');

    // Cache scoring data per league for 30 seconds (scores update every 5 min from sync)
    // NOTE: isMe is per-user, so we cache the scoring data WITHOUT isMe and apply it per-request
    const cacheKey = `weekly-scores:${req.params.leagueId}`;
    const cached = cache.get(cacheKey);

    if (cached) {
      // Stamp isMe per-request from cached data
      const teams = cached.teams.map(t => ({
        ...t,
        isMe: t._userId === req.user.id,
      }));
      return res.json({ tournament: cached.tournament, teams });
    }

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

      let teamPoints = 0, teamHolePoints = 0, teamStatPoints = 0, teamPosPoints = 0;
      const players = [];

      for (const starter of starters) {
        const calc = pointsMap[starter.player_name] || { points: 0, hole_points: 0, stat_points: 0, position_points: 0, holes_played: 0 };
        teamPoints += calc.points;
        teamHolePoints += calc.hole_points;
        teamStatPoints += calc.stat_points;
        teamPosPoints += calc.position_points || 0;
        players.push({ playerName: starter.player_name, slot: 'starter', ...calc });
      }

      for (const bp of benchPlayers) {
        players.push({ playerName: bp.player_name, slot: 'bench', points: 0, hole_points: 0, stat_points: 0, position_points: 0, holes_played: 0 });
      }

      return {
        memberId: member.id,
        teamName: member.team_name,
        displayName: member.users?.display_name,
        _userId: member.user_id,
        isMe: member.user_id === req.user.id,
        totalPoints: +teamPoints.toFixed(2),
        holePoints: +teamHolePoints.toFixed(2),
        statPoints: +teamStatPoints.toFixed(2),
        positionPoints: +teamPosPoints.toFixed(2),
        players,
      };
    });

    teams.sort((a, b) => b.totalPoints - a.totalPoints);
    const result = { tournament, teams };
    cache.set(cacheKey, result, 30_000); // 30 sec cache
    // Return with correct isMe for THIS user (cache has _userId for re-stamping)
    const responseTeams = teams.map(t => ({ ...t, isMe: t._userId === req.user.id }));
    res.json({ tournament, teams: responseTeams });
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

    const { data: weeklyResults } = await supabase
      .from('weekly_results')
      .select('*')
      .eq('league_id', league.id);

    const standings = (members || []).map(member => {
      const memberResults = (weeklyResults || []).filter(r => r.member_id === member.id);
      const totalSeasonPoints = memberResults.reduce((sum, r) => sum + parseFloat(r.season_points || 0), 0);
      const totalFantasyPoints = memberResults.reduce((sum, r) => sum + parseFloat(r.weekly_points || 0), 0);
      const tournamentsPlayed = memberResults.length;
      const avgPosition = tournamentsPlayed > 0
        ? +(memberResults.reduce((sum, r) => sum + r.position, 0) / tournamentsPlayed).toFixed(1)
        : null;

      return {
        memberId: member.id,
        teamName: member.team_name,
        displayName: member.users?.display_name,
        totalPoints: totalSeasonPoints,
        totalFantasyPoints: +totalFantasyPoints.toFixed(2),
        tournamentsPlayed,
        avgPosition,
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
    const { DEFAULT_SCORING, calcPositionPoints, calcFlatStatPoints } = require('../services/seasonScoring');

    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Season league only' });
    }

    const scoring = { ...DEFAULT_SCORING, ...(league.scoring_config || {}) };

    const { data: weeklyResults } = await supabase
      .from('weekly_results')
      .select('*, league_members(team_name, users(display_name))')
      .eq('league_id', league.id)
      .order('tournament_id', { ascending: false })
      .order('position');

    const tournamentIds = [...new Set((weeklyResults || []).map(r => r.tournament_id))];
    let tournaments = [];
    if (tournamentIds.length > 0) {
      const { data } = await supabase.from('tournaments').select('id, name').in('id', tournamentIds);
      tournaments = data || [];
    }

    const tournamentMap = {};
    for (const t of tournaments) tournamentMap[t.id] = t.name;

    let allLineups = [];
    if (tournamentIds.length > 0) {
      const { data } = await supabase.from('lineups')
        .select('member_id, tournament_id, player_name, slot')
        .eq('league_id', league.id).in('tournament_id', tournamentIds).eq('slot', 'starter');
      allLineups = data || [];
    }

    let allPlayerResults = [];
    if (tournamentIds.length > 0) {
      const { data } = await supabase.from('player_tournament_results').select('*').in('tournament_id', tournamentIds);
      allPlayerResults = data || [];
    }

    const resultsByKey = {};
    for (const r of allPlayerResults) {
      resultsByKey[`${r.tournament_id}:${r.player_name.toLowerCase()}`] = r;
    }

    // Apply league scoring to raw stats (flat system)
    function calcPlayerPoints(raw) {
      const holePoints =
        (raw.eagles || 0) * scoring.eagle +
        (raw.birdies || 0) * scoring.birdie +
        (raw.pars || 0) * scoring.par +
        (raw.bogeys || 0) * scoring.bogey +
        (raw.doubles_or_worse || 0) * scoring.double_bogey;

      const statResult = calcFlatStatPoints(raw, scoring);
      const posResult = calcPositionPoints(raw.position, scoring);

      return {
        points: +(holePoints + statResult.statPoints + posResult.position_points).toFixed(2),
        hole_points: +holePoints.toFixed(2),
        stat_points: statResult.statPoints,
        stat_breakdown: statResult.breakdown,
        position_points: posResult.position_points,
        position: posResult.position,
        eagles: raw.eagles || 0,
        birdies: raw.birdies || 0,
        pars: raw.pars || 0,
        bogeys: raw.bogeys || 0,
        doubles_or_worse: raw.doubles_or_worse || 0,
        holes_played: raw.holes_played || 0,
      };
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

      // Get this member's starters for this tournament
      const memberStarters = allLineups.filter(
        l => l.member_id === r.member_id && l.tournament_id === r.tournament_id
      );

      // Calculate points for each player using raw data + league scoring
      const players = memberStarters.map(starter => {
        const raw = resultsByKey[`${r.tournament_id}:${starter.player_name.toLowerCase()}`];
        if (!raw) {
          return { playerName: starter.player_name, points: 0, hole_points: 0, stat_points: 0, stat_breakdown: {}, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_or_worse: 0, holes_played: 0 };
        }
        return { playerName: starter.player_name, ...calcPlayerPoints(raw) };
      }).sort((a, b) => b.points - a.points);

      weeks[r.tournament_id].results.push({
        memberId: r.member_id,
        teamName: r.league_members?.team_name,
        displayName: r.league_members?.users?.display_name,
        weeklyPoints: parseFloat(r.weekly_points),
        position: r.position,
        seasonPoints: parseFloat(r.season_points),
        players,
      });
    }

    res.json(Object.values(weeks));
  } catch (err) {
    console.error('Weekly history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lineups/:leagueId/all-players — All DG players with roster ownership + tournament history
router.get('/:leagueId/all-players', auth, async (req, res) => {
  try {
    const { DEFAULT_SCORING, calcPositionPoints, calcFlatStatPoints } = require('../services/seasonScoring');

    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Season league only' });
    }

    const scoring = { ...DEFAULT_SCORING, ...(league.scoring_config || {}) };

    const [
      { data: allPlayers },
      { data: allRosters },
      { data: members },
      { data: tournamentResults },
      { data: tournaments },
    ] = await Promise.all([
      supabase.from('player_stats')
        .select('player_name, owgr_rank, dg_rank, sg_total')
        .order('dg_rank', { ascending: true, nullsFirst: false }),
      supabase.from('rosters')
        .select('player_name, member_id')
        .eq('league_id', league.id),
      supabase.from('league_members')
        .select('id, team_name, user_id')
        .eq('league_id', league.id),
      supabase.from('player_tournament_results').select('*'),
      supabase.from('tournaments')
        .select('id, name, start_date')
        .order('start_date', { ascending: true }),
    ]);

    const memberMap = {};
    for (const m of members || []) {
      memberMap[m.id] = { teamName: m.team_name, isMe: m.user_id === req.user.id };
    }

    const ownershipMap = {};
    for (const r of allRosters || []) {
      const member = memberMap[r.member_id];
      if (member) {
        ownershipMap[r.player_name.toLowerCase()] = { teamName: member.teamName, isMe: member.isMe };
      }
    }

    const tournamentMap = {};
    const tournamentList = [];
    for (const t of tournaments || []) {
      tournamentMap[t.id] = t.name;
      tournamentList.push({ id: t.id, name: t.name });
    }

    // Build tournament results using flat scoring
    const resultsByPlayer = {};
    for (const r of tournamentResults || []) {
      const key = r.player_name.toLowerCase();
      if (!resultsByPlayer[key]) resultsByPlayer[key] = [];

      const holePoints =
        (r.eagles || 0) * scoring.eagle +
        (r.birdies || 0) * scoring.birdie +
        (r.pars || 0) * scoring.par +
        (r.bogeys || 0) * scoring.bogey +
        (r.doubles_or_worse || 0) * scoring.double_bogey;

      const statResult = calcFlatStatPoints(r, scoring);
      const posResult = calcPositionPoints(r.position, scoring);
      const totalPoints = +(holePoints + statResult.statPoints + posResult.position_points).toFixed(2);

      resultsByPlayer[key].push({
        tournamentId: r.tournament_id,
        tournamentName: tournamentMap[r.tournament_id] || 'Unknown',
        points: totalPoints,
        posPoints: posResult.position_points,
        position: posResult.position,
        holePoints: +holePoints.toFixed(2),
        eagles: r.eagles || 0,
        birdies: r.birdies || 0,
        pars: r.pars || 0,
        bogeys: r.bogeys || 0,
        doubles: r.doubles_or_worse || 0,
        statPoints: statResult.statPoints,
        firPts: statResult.breakdown.fir?.pts || 0,
        girPts: statResult.breakdown.gir?.pts || 0,
        distPts: statResult.breakdown.distance?.pts || 0,
        greatPts: statResult.breakdown.great_shots?.pts || 0,
        poorPts: statResult.breakdown.poor_shots?.pts || 0,
        holesPlayed: r.holes_played || 0,
      });
    }

    // Sort each player's results by tournament date order
    const tournamentOrder = {};
    (tournaments || []).forEach((t, i) => { tournamentOrder[t.id] = i; });
    for (const key of Object.keys(resultsByPlayer)) {
      resultsByPlayer[key].sort((a, b) => (tournamentOrder[a.tournamentId] || 0) - (tournamentOrder[b.tournamentId] || 0));
    }

    // Build player list
    const players = (allPlayers || []).map(p => {
      const key = p.player_name.toLowerCase();
      const owner = ownershipMap[key] || null;
      const history = resultsByPlayer[key] || [];

      return {
        playerName: p.player_name,
        dgRank: p.dg_rank,
        owgrRank: p.owgr_rank,
        sgTotal: parseFloat(p.sg_total),
        owner: owner ? { teamName: owner.teamName, isMe: owner.isMe } : null,
        history,
      };
    });

    // Get finalized tournament IDs that have results (for the grid columns)
    const finalizedTournaments = tournamentList.filter(t =>
      (tournamentResults || []).some(r => r.tournament_id === t.id)
    );

    res.json({ players, tournaments: finalizedTournaments });
  } catch (err) {
    console.error('All players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
