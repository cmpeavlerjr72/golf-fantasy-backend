const supabase = require('../config/supabase');

// Generate default season points distribution based on league size
// Top-heavy like FedEx Cup
function generateSeasonPoints(teamCount) {
  const base = {
    2:  [500, 200],
    3:  [500, 300, 150],
    4:  [500, 300, 200, 100],
    5:  [500, 300, 200, 150, 75],
    6:  [500, 300, 200, 150, 100, 50],
    7:  [500, 300, 200, 150, 100, 75, 50],
    8:  [500, 300, 200, 150, 100, 75, 50, 25],
    10: [500, 350, 250, 200, 150, 120, 100, 80, 60, 40],
    12: [500, 350, 275, 225, 175, 150, 125, 100, 80, 60, 40, 25],
  };

  // Find the closest defined size or interpolate
  if (base[teamCount]) return base[teamCount];

  // For sizes not predefined, generate a curve
  const points = [];
  for (let i = 0; i < teamCount; i++) {
    const pct = i / (teamCount - 1); // 0 to 1
    const pts = Math.round(500 * Math.pow(1 - pct, 1.5));
    points.push(Math.max(pts, 25));
  }
  points[0] = 500; // always 500 for first
  return points;
}

// Check if a player is tee-time locked for the current tournament
async function isPlayerLocked(tournamentId, playerName) {
  const { data: teeTimes } = await supabase
    .from('tee_times')
    .select('tee_time, round_num')
    .eq('tournament_id', tournamentId)
    .ilike('player_name', playerName)
    .order('round_num');

  if (!teeTimes || teeTimes.length === 0) return false;

  const now = new Date();
  // Player is locked if their earliest upcoming or past tee time has passed
  const firstTeeTime = new Date(teeTimes[0].tee_time);
  return now >= firstTeeTime;
}

// Calculate weekly fantasy points for a member's starters
async function calculateWeeklyPoints(leagueId, memberId, tournamentId, scoringConfig) {
  // Get this member's starters for this tournament
  const { data: lineup } = await supabase
    .from('lineups')
    .select('player_name')
    .eq('league_id', leagueId)
    .eq('member_id', memberId)
    .eq('tournament_id', tournamentId)
    .eq('slot', 'starter');

  if (!lineup || lineup.length === 0) return { points: 0, breakdown: {} };

  const starterNames = lineup.map(l => l.player_name);

  // Get hole scores for these players
  const { data: holes } = await supabase
    .from('hole_scores')
    .select('player_name, score, par')
    .eq('tournament_id', tournamentId)
    .in('player_name', starterNames);

  let totalPoints = 0;
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, holesPlayed = 0;

  for (const hole of holes || []) {
    if (hole.score === null) continue;
    holesPlayed++;

    const diff = hole.score - hole.par;
    if (diff <= -2) {
      totalPoints += scoringConfig.eagle || 4;
      eagles++;
    } else if (diff === -1) {
      totalPoints += scoringConfig.birdie || 3;
      birdies++;
    } else if (diff === 0) {
      totalPoints += scoringConfig.par || 1;
      pars++;
    } else if (diff === 1) {
      totalPoints += scoringConfig.bogey || -1;
      bogeys++;
    } else if (diff === 2) {
      totalPoints += scoringConfig.double_bogey || -2;
      doubles++;
    } else {
      totalPoints += scoringConfig.worse || -3;
      doubles++;
    }
  }

  return {
    points: totalPoints,
    eagles, birdies, pars, bogeys, doubles_or_worse: doubles, holes_played: holesPlayed,
  };
}

// Process end-of-week: calculate all weekly points, assign positions, award season points
async function processWeeklyResults(leagueId, tournamentId) {
  const { data: league } = await supabase
    .from('leagues')
    .select('*')
    .eq('id', leagueId)
    .single();

  if (!league || league.league_type !== 'season') return;

  const { data: members } = await supabase
    .from('league_members')
    .select('id')
    .eq('league_id', leagueId);

  const scoringConfig = league.scoring_config || {};
  const seasonPointsDist = league.season_points_config || generateSeasonPoints(members.length);

  // Calculate weekly points for each member
  const results = [];
  for (const member of members) {
    const calc = await calculateWeeklyPoints(leagueId, member.id, tournamentId, scoringConfig);
    results.push({ memberId: member.id, ...calc });
  }

  // Sort by points descending and assign positions
  results.sort((a, b) => b.points - a.points);
  results.forEach((r, i) => {
    r.position = i + 1;
    r.seasonPoints = seasonPointsDist[i] || seasonPointsDist[seasonPointsDist.length - 1] || 25;
  });

  // Upsert weekly results
  for (const r of results) {
    await supabase
      .from('weekly_results')
      .upsert({
        league_id: leagueId,
        tournament_id: tournamentId,
        member_id: r.memberId,
        weekly_points: r.points,
        position: r.position,
        season_points: r.seasonPoints,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'league_id,tournament_id,member_id' });

    // Also upsert season_scores for detailed breakdown
    // Get starters to log per-player
    const { data: lineup } = await supabase
      .from('lineups')
      .select('player_name')
      .eq('league_id', leagueId)
      .eq('member_id', r.memberId)
      .eq('tournament_id', tournamentId)
      .eq('slot', 'starter');

    for (const starter of lineup || []) {
      const playerCalc = await calculatePlayerPoints(tournamentId, starter.player_name, scoringConfig);
      await supabase
        .from('season_scores')
        .upsert({
          league_id: leagueId,
          member_id: r.memberId,
          tournament_id: tournamentId,
          player_name: starter.player_name,
          points: playerCalc.points,
          eagles: playerCalc.eagles,
          birdies: playerCalc.birdies,
          pars: playerCalc.pars,
          bogeys: playerCalc.bogeys,
          doubles_or_worse: playerCalc.doubles_or_worse,
          holes_played: playerCalc.holes_played,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'league_id,member_id,tournament_id,player_name' });
    }
  }

  return results;
}

// Calculate points for a single player
async function calculatePlayerPoints(tournamentId, playerName, scoringConfig) {
  const { data: holes } = await supabase
    .from('hole_scores')
    .select('score, par')
    .eq('tournament_id', tournamentId)
    .ilike('player_name', playerName);

  let points = 0, eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, holesPlayed = 0;

  for (const hole of holes || []) {
    if (hole.score === null) continue;
    holesPlayed++;
    const diff = hole.score - hole.par;
    if (diff <= -2) { points += scoringConfig.eagle || 4; eagles++; }
    else if (diff === -1) { points += scoringConfig.birdie || 3; birdies++; }
    else if (diff === 0) { points += scoringConfig.par || 1; pars++; }
    else if (diff === 1) { points += scoringConfig.bogey || -1; bogeys++; }
    else if (diff === 2) { points += scoringConfig.double_bogey || -2; doubles++; }
    else { points += scoringConfig.worse || -3; doubles++; }
  }

  return { points, eagles, birdies, pars, bogeys, doubles_or_worse: doubles, holes_played: holesPlayed };
}

module.exports = {
  generateSeasonPoints,
  isPlayerLocked,
  calculateWeeklyPoints,
  processWeeklyResults,
};
