const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const DEFAULT_SEASON_SCORING = {
  eagle: 4,
  birdie: 3,
  par: 1,
  bogey: -1,
  double_bogey: -2,
  worse: -3,
};

// POST /api/leagues — Create a new league
router.post('/', auth, async (req, res) => {
  const {
    name, teamName, maxTeams = 8, scoringTopN = 4, draftRounds = 4,
    leagueType = 'pool', scoringConfig, rosterSize, startersCount,
  } = req.body;

  if (!name || !teamName) {
    return res.status(400).json({ error: 'League name and your team name are required' });
  }

  const isPool = leagueType === 'pool';

  try {
    const inviteCode = generateInviteCode();

    const { data: league, error: leagueErr } = await supabase
      .from('leagues')
      .insert({
        name,
        invite_code: inviteCode,
        owner_id: req.user.id,
        max_teams: maxTeams,
        scoring_top_n: isPool ? scoringTopN : null,
        draft_rounds: draftRounds,
        league_type: leagueType,
        scoring_config: isPool ? {} : (scoringConfig || DEFAULT_SEASON_SCORING),
        roster_size: isPool ? draftRounds : (rosterSize || 6),
        starters_count: isPool ? draftRounds : (startersCount || 4),
      })
      .select()
      .single();

    if (leagueErr) throw leagueErr;

    const { error: memberErr } = await supabase
      .from('league_members')
      .insert({
        league_id: league.id,
        user_id: req.user.id,
        team_name: teamName,
        draft_order: 1,
      });

    if (memberErr) throw memberErr;

    res.status(201).json({
      id: league.id,
      name: league.name,
      inviteCode: league.invite_code,
      maxTeams: league.max_teams,
      leagueType: league.league_type,
      scoringTopN: league.scoring_top_n,
      scoringConfig: league.scoring_config,
      draftRounds: league.draft_rounds,
      rosterSize: league.roster_size,
      startersCount: league.starters_count,
      status: league.status,
    });
  } catch (err) {
    console.error('Create league error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leagues/join — Join a league by invite code
router.post('/join', auth, async (req, res) => {
  const { inviteCode, teamName } = req.body;

  if (!inviteCode || !teamName) {
    return res.status(400).json({ error: 'Invite code and team name are required' });
  }

  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('invite_code', inviteCode.toUpperCase())
      .maybeSingle();

    if (!league) {
      return res.status(404).json({ error: 'League not found' });
    }
    if (league.status !== 'pre_draft') {
      return res.status(400).json({ error: 'League draft has already started' });
    }

    const { data: existing } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'You are already in this league' });
    }

    const { data: members } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league.id);

    const count = members ? members.length : 0;
    if (count >= league.max_teams) {
      return res.status(400).json({ error: 'League is full' });
    }

    const { error } = await supabase
      .from('league_members')
      .insert({
        league_id: league.id,
        user_id: req.user.id,
        team_name: teamName,
        draft_order: count + 1,
      });

    if (error) throw error;

    res.json({ id: league.id, name: league.name, inviteCode: league.invite_code });
  } catch (err) {
    console.error('Join league error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leagues — List user's leagues
router.get('/', auth, async (req, res) => {
  try {
    const { data: memberships, error } = await supabase
      .from('league_members')
      .select('team_name, leagues(*)')
      .eq('user_id', req.user.id)
      .order('created_at', { referencedTable: 'leagues', ascending: false });

    if (error) throw error;

    const results = [];
    for (const m of memberships || []) {
      const league = m.leagues;
      const { count } = await supabase
        .from('league_members')
        .select('*', { count: 'exact', head: true })
        .eq('league_id', league.id);

      results.push({
        id: league.id,
        name: league.name,
        inviteCode: league.invite_code,
        status: league.status,
        leagueType: league.league_type,
        maxTeams: league.max_teams,
        memberCount: count,
        myTeamName: m.team_name,
        isOwner: league.owner_id === req.user.id,
      });
    }

    res.json(results);
  } catch (err) {
    console.error('List leagues error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leagues/:id — Get league details
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!league) {
      return res.status(404).json({ error: 'League not found' });
    }

    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this league' });
    }

    const { data: members } = await supabase
      .from('league_members')
      .select('id, team_name, draft_order, user_id, users(display_name)')
      .eq('league_id', league.id)
      .order('draft_order');

    const { data: picks } = await supabase
      .from('draft_picks')
      .select('*, league_members(team_name)')
      .eq('league_id', league.id)
      .order('pick_number');

    // For season leagues, include roster data per member
    let memberRosters = {};
    if (league.league_type === 'season') {
      const { data: allRosters } = await supabase
        .from('rosters')
        .select('member_id, player_name')
        .eq('league_id', league.id);
      for (const r of allRosters || []) {
        if (!memberRosters[r.member_id]) memberRosters[r.member_id] = [];
        memberRosters[r.member_id].push({ playerName: r.player_name });
      }
    }

    res.json({
      id: league.id,
      name: league.name,
      inviteCode: league.invite_code,
      status: league.status,
      leagueType: league.league_type,
      maxTeams: league.max_teams,
      scoringTopN: league.scoring_top_n,
      scoringConfig: league.scoring_config,
      draftRounds: league.draft_rounds,
      rosterSize: league.roster_size,
      startersCount: league.starters_count,
      isOwner: league.owner_id === req.user.id,
      members: (members || []).map(m => ({
        id: m.id,
        teamName: m.team_name,
        displayName: m.users?.display_name,
        draftOrder: m.draft_order,
        isMe: m.user_id === req.user.id,
        roster: memberRosters[m.id] || [],
      })),
      picks: (picks || []).map(p => ({
        id: p.id,
        memberId: p.member_id,
        teamName: p.league_members?.team_name,
        playerName: p.player_name,
        round: p.round,
        pickNumber: p.pick_number,
      })),
    });
  } catch (err) {
    console.error('Get league error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leagues/:id/standings — Get league standings with scores
router.get('/:id/standings', auth, async (req, res) => {
  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!league) {
      return res.status(404).json({ error: 'League not found' });
    }

    const { data: members } = await supabase
      .from('league_members')
      .select('id, team_name, users(display_name)')
      .eq('league_id', league.id);

    const { data: picks } = await supabase
      .from('draft_picks')
      .select('member_id, player_name')
      .eq('league_id', league.id);

    // Get active tournament scores
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('*')
      .eq('is_active', true)
      .maybeSingle();

    let scores = [];
    if (tournament) {
      const { data } = await supabase
        .from('player_scores')
        .select('*')
        .eq('tournament_id', tournament.id);
      scores = data || [];
    }

    const standings = (members || []).map(member => {
      const memberPicks = (picks || []).filter(p => p.member_id === member.id);
      const playerScores = memberPicks.map(pick => {
        const score = scores.find(s =>
          s.player_name.toLowerCase().trim() === pick.player_name.toLowerCase().trim()
        );
        return {
          playerName: pick.player_name,
          scoreToPar: score ? score.score_to_par : null,
          thru: score ? score.thru : '-',
          today: score ? score.today : null,
          position: score ? score.position : '-',
        };
      });

      const validScores = playerScores
        .filter(p => p.scoreToPar !== null)
        .sort((a, b) => a.scoreToPar - b.scoreToPar);

      const countingScores = validScores.slice(0, league.scoring_top_n);
      const teamScore = countingScores.reduce((sum, p) => sum + p.scoreToPar, 0);

      return {
        memberId: member.id,
        teamName: member.team_name,
        displayName: member.users?.display_name,
        teamScore: validScores.length > 0 ? teamScore : null,
        players: playerScores,
        countingPlayers: countingScores.length,
      };
    });

    standings.sort((a, b) => {
      if (a.teamScore === null) return 1;
      if (b.teamScore === null) return -1;
      return a.teamScore - b.teamScore;
    });

    res.json({
      leagueName: league.name,
      scoringTopN: league.scoring_top_n,
      tournament: tournament || null,
      standings,
    });
  } catch (err) {
    console.error('Standings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
