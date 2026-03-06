const supabase = require('../config/supabase');

// Default scoring config with stat bonuses
const DEFAULT_SCORING = {
  // Hole-by-hole points
  eagle: 5,
  birdie: 3,
  par: 0.5,
  bogey: -1,
  double_bogey: -3,
  worse: -5,
  // Stat multipliers (relative to field average) — calibrated for ~45% stat influence
  fir_multiplier: 77,         // (player_fir - field_avg) * multiplier
  gir_multiplier: 104,        // GIR matters more than FIR
  distance_multiplier: 0.77,  // per yard above/below average
  // Great/poor shot bonuses
  great_shot_bonus: 3.91,     // per great shot
  poor_shot_penalty: -3.91,   // per poor shot
};

// Generate default season points distribution based on league size
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

  if (base[teamCount]) return base[teamCount];

  const points = [];
  for (let i = 0; i < teamCount; i++) {
    const pct = i / (teamCount - 1);
    const pts = Math.round(500 * Math.pow(1 - pct, 1.5));
    points.push(Math.max(pts, 25));
  }
  points[0] = 500;
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
  const firstTeeTime = new Date(teeTimes[0].tee_time);
  return now >= firstTeeTime;
}

// Calculate hole-by-hole points for a single player
function calcHolePoints(holes, scoring) {
  let points = 0, eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, holesPlayed = 0;

  for (const hole of holes || []) {
    if (hole.score === null) continue;
    holesPlayed++;
    const diff = hole.score - hole.par;
    if (diff <= -2) { points += scoring.eagle; eagles++; }
    else if (diff === -1) { points += scoring.birdie; birdies++; }
    else if (diff === 0) { points += scoring.par; pars++; }
    else if (diff === 1) { points += scoring.bogey; bogeys++; }
    else if (diff === 2) { points += scoring.double_bogey; doubles++; }
    else { points += scoring.worse; doubles++; }
  }

  return { points, eagles, birdies, pars, bogeys, doubles_or_worse: doubles, holes_played: holesPlayed };
}

// Calculate stat bonus points for a single player relative to field averages
async function calcStatBonus(tournamentId, playerName, scoring) {
  const { data: playerStats } = await supabase
    .from('tournament_stats')
    .select('*')
    .eq('tournament_id', tournamentId)
    .ilike('player_name', playerName)
    .maybeSingle();

  const { data: fieldAvg } = await supabase
    .from('tournament_field_averages')
    .select('*')
    .eq('tournament_id', tournamentId)
    .maybeSingle();

  if (!playerStats || !fieldAvg) return { statPoints: 0, breakdown: {} };

  let statPoints = 0;
  const breakdown = {};

  // FIR relative scoring
  if (playerStats.accuracy != null && fieldAvg.avg_accuracy != null) {
    const firDiff = playerStats.accuracy - fieldAvg.avg_accuracy;
    const firPts = +(firDiff * (scoring.fir_multiplier || 0)).toFixed(2);
    statPoints += firPts;
    breakdown.fir = { value: playerStats.accuracy, avg: fieldAvg.avg_accuracy, pts: firPts };
  }

  // GIR relative scoring
  if (playerStats.gir != null && fieldAvg.avg_gir != null) {
    const girDiff = playerStats.gir - fieldAvg.avg_gir;
    const girPts = +(girDiff * (scoring.gir_multiplier || 0)).toFixed(2);
    statPoints += girPts;
    breakdown.gir = { value: playerStats.gir, avg: fieldAvg.avg_gir, pts: girPts };
  }

  // Driving distance relative scoring
  if (playerStats.distance != null && fieldAvg.avg_distance != null) {
    const distDiff = playerStats.distance - fieldAvg.avg_distance;
    const distPts = +(distDiff * (scoring.distance_multiplier || 0)).toFixed(2);
    statPoints += distPts;
    breakdown.distance = { value: playerStats.distance, avg: fieldAvg.avg_distance, pts: distPts };
  }

  // Great shots bonus
  if (playerStats.great_shots != null) {
    const greatPts = +(playerStats.great_shots * (scoring.great_shot_bonus || 0)).toFixed(2);
    statPoints += greatPts;
    breakdown.great_shots = { count: playerStats.great_shots, pts: greatPts };
  }

  // Poor shots penalty
  if (playerStats.poor_shots != null) {
    const poorPts = +(playerStats.poor_shots * (scoring.poor_shot_penalty || 0)).toFixed(2);
    statPoints += poorPts;
    breakdown.poor_shots = { count: playerStats.poor_shots, pts: poorPts };
  }

  return { statPoints: +statPoints.toFixed(2), breakdown };
}

// Calculate total fantasy points for a single player (holes + stats)
async function calculatePlayerPoints(tournamentId, playerName, scoringConfig) {
  const scoring = { ...DEFAULT_SCORING, ...scoringConfig };

  const { data: holes } = await supabase
    .from('hole_scores')
    .select('score, par')
    .eq('tournament_id', tournamentId)
    .ilike('player_name', playerName);

  const holeResult = calcHolePoints(holes, scoring);
  const statResult = await calcStatBonus(tournamentId, playerName, scoring);

  return {
    points: +(holeResult.points + statResult.statPoints).toFixed(2),
    hole_points: holeResult.points,
    stat_points: statResult.statPoints,
    stat_breakdown: statResult.breakdown,
    eagles: holeResult.eagles,
    birdies: holeResult.birdies,
    pars: holeResult.pars,
    bogeys: holeResult.bogeys,
    doubles_or_worse: holeResult.doubles_or_worse,
    holes_played: holeResult.holes_played,
  };
}

// Calculate weekly fantasy points for a member's starters
async function calculateWeeklyPoints(leagueId, memberId, tournamentId, scoringConfig) {
  const { data: lineup } = await supabase
    .from('lineups')
    .select('player_name')
    .eq('league_id', leagueId)
    .eq('member_id', memberId)
    .eq('tournament_id', tournamentId)
    .eq('slot', 'starter');

  if (!lineup || lineup.length === 0) return { points: 0, hole_points: 0, stat_points: 0 };

  let totalPoints = 0, totalHole = 0, totalStat = 0;
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, holesPlayed = 0;

  for (const starter of lineup) {
    const calc = await calculatePlayerPoints(tournamentId, starter.player_name, scoringConfig);
    totalPoints += calc.points;
    totalHole += calc.hole_points;
    totalStat += calc.stat_points;
    eagles += calc.eagles;
    birdies += calc.birdies;
    pars += calc.pars;
    bogeys += calc.bogeys;
    doubles += calc.doubles_or_worse;
    holesPlayed += calc.holes_played;
  }

  return {
    points: +totalPoints.toFixed(2),
    hole_points: +totalHole.toFixed(2),
    stat_points: +totalStat.toFixed(2),
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

  const results = [];
  for (const member of members) {
    const calc = await calculateWeeklyPoints(leagueId, member.id, tournamentId, scoringConfig);
    results.push({ memberId: member.id, ...calc });
  }

  results.sort((a, b) => b.points - a.points);
  results.forEach((r, i) => {
    r.position = i + 1;
    r.seasonPoints = seasonPointsDist[i] || seasonPointsDist[seasonPointsDist.length - 1] || 25;
  });

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

    // Per-player breakdown
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

// Batch calculate points for multiple players in 3 total DB queries instead of 3 per player
async function calculatePlayerPointsBatch(tournamentId, playerNames, scoringConfig) {
  const scoring = { ...DEFAULT_SCORING, ...scoringConfig };

  // 1. Fetch ALL hole scores for these players in one query
  const { data: allHoles } = await supabase
    .from('hole_scores')
    .select('player_name, score, par')
    .eq('tournament_id', tournamentId)
    .in('player_name', playerNames);

  // 2. Fetch ALL tournament stats for these players in one query
  const { data: allStats } = await supabase
    .from('tournament_stats')
    .select('*')
    .eq('tournament_id', tournamentId)
    .in('player_name', playerNames);

  // 3. Fetch field averages once
  const { data: fieldAvg } = await supabase
    .from('tournament_field_averages')
    .select('*')
    .eq('tournament_id', tournamentId)
    .maybeSingle();

  // Build lookup maps
  const holesByPlayer = {};
  for (const h of allHoles || []) {
    const key = h.player_name.toLowerCase();
    if (!holesByPlayer[key]) holesByPlayer[key] = [];
    holesByPlayer[key].push(h);
  }

  const statsByPlayer = {};
  for (const s of allStats || []) {
    statsByPlayer[s.player_name.toLowerCase()] = s;
  }

  // Calculate for each player in memory
  const results = {};
  for (const name of playerNames) {
    const key = name.toLowerCase();
    const holes = holesByPlayer[key] || [];
    const holeResult = calcHolePoints(holes, scoring);

    // Stat bonus calculation inline
    let statPoints = 0;
    const breakdown = {};
    const ps = statsByPlayer[key];

    if (ps && fieldAvg) {
      if (ps.accuracy != null && fieldAvg.avg_accuracy != null) {
        const firDiff = ps.accuracy - fieldAvg.avg_accuracy;
        const firPts = +(firDiff * (scoring.fir_multiplier || 0)).toFixed(2);
        statPoints += firPts;
        breakdown.fir = { value: ps.accuracy, avg: fieldAvg.avg_accuracy, pts: firPts };
      }
      if (ps.gir != null && fieldAvg.avg_gir != null) {
        const girDiff = ps.gir - fieldAvg.avg_gir;
        const girPts = +(girDiff * (scoring.gir_multiplier || 0)).toFixed(2);
        statPoints += girPts;
        breakdown.gir = { value: ps.gir, avg: fieldAvg.avg_gir, pts: girPts };
      }
      if (ps.distance != null && fieldAvg.avg_distance != null) {
        const distDiff = ps.distance - fieldAvg.avg_distance;
        const distPts = +(distDiff * (scoring.distance_multiplier || 0)).toFixed(2);
        statPoints += distPts;
        breakdown.distance = { value: ps.distance, avg: fieldAvg.avg_distance, pts: distPts };
      }
      if (ps.great_shots != null) {
        const greatPts = +(ps.great_shots * (scoring.great_shot_bonus || 0)).toFixed(2);
        statPoints += greatPts;
        breakdown.great_shots = { count: ps.great_shots, pts: greatPts };
      }
      if (ps.poor_shots != null) {
        const poorPts = +(ps.poor_shots * (scoring.poor_shot_penalty || 0)).toFixed(2);
        statPoints += poorPts;
        breakdown.poor_shots = { count: ps.poor_shots, pts: poorPts };
      }
    }

    statPoints = +statPoints.toFixed(2);

    results[name] = {
      points: +(holeResult.points + statPoints).toFixed(2),
      hole_points: holeResult.points,
      stat_points: statPoints,
      stat_breakdown: breakdown,
      eagles: holeResult.eagles,
      birdies: holeResult.birdies,
      pars: holeResult.pars,
      bogeys: holeResult.bogeys,
      doubles_or_worse: holeResult.doubles_or_worse,
      holes_played: holeResult.holes_played,
    };
  }

  return results;
}

module.exports = {
  DEFAULT_SCORING,
  generateSeasonPoints,
  isPlayerLocked,
  calculateWeeklyPoints,
  calculatePlayerPoints,
  calculatePlayerPointsBatch,
  processWeeklyResults,
};
