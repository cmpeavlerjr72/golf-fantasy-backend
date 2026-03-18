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
  // Position-based points (leaderboard finish)
  position_points: {
    1: 30, 2: 20, 3: 15, 4: 12, 5: 10,
    6: 8, 7: 7, 8: 6, 9: 5, 10: 4,
    top15: 3, top20: 2, top30: 1, other: 0, cut: -5,
  },
};

// Parse position string ("1", "T3", "T47", "CUT") into a numeric value
function parsePosition(pos) {
  if (!pos) return null;
  const s = String(pos).trim().toUpperCase();
  if (s === 'CUT' || s === 'MC' || s === 'WD' || s === 'DQ') return s;
  const num = parseInt(s.replace(/^T/, ''), 10);
  return isNaN(num) ? null : num;
}

// Calculate position points from a position string
function calcPositionPoints(pos, scoring) {
  const ppConfig = scoring.position_points || DEFAULT_SCORING.position_points;
  const parsed = parsePosition(pos);
  if (parsed === null) return { position_points: 0, position: pos || null };
  if (typeof parsed === 'string') {
    // CUT, WD, DQ, MC
    return { position_points: ppConfig.cut || -5, position: pos };
  }
  // Exact position match (1-10)
  if (ppConfig[parsed] !== undefined) {
    return { position_points: ppConfig[parsed], position: pos };
  }
  // Range-based
  if (parsed <= 15) return { position_points: ppConfig.top15 || 3, position: pos };
  if (parsed <= 20) return { position_points: ppConfig.top20 || 2, position: pos };
  if (parsed <= 30) return { position_points: ppConfig.top30 || 1, position: pos };
  return { position_points: ppConfig.other || 0, position: pos };
}

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

// Calculate total fantasy points for a single player (holes + stats + position)
async function calculatePlayerPoints(tournamentId, playerName, scoringConfig) {
  const scoring = { ...DEFAULT_SCORING, ...scoringConfig };

  const [{ data: holes }, { data: playerScore }] = await Promise.all([
    supabase.from('hole_scores').select('score, par')
      .eq('tournament_id', tournamentId).ilike('player_name', playerName),
    supabase.from('player_scores').select('position')
      .eq('tournament_id', tournamentId).ilike('player_name', playerName).maybeSingle(),
  ]);

  const holeResult = calcHolePoints(holes, scoring);
  const statResult = await calcStatBonus(tournamentId, playerName, scoring);
  const posResult = calcPositionPoints(playerScore?.position, scoring);

  return {
    points: +(holeResult.points + statResult.statPoints + posResult.position_points).toFixed(2),
    hole_points: holeResult.points,
    stat_points: statResult.statPoints,
    stat_breakdown: statResult.breakdown,
    position_points: posResult.position_points,
    position: posResult.position,
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

  if (!lineup || lineup.length === 0) return { points: 0, hole_points: 0, stat_points: 0, position_points: 0 };

  let totalPoints = 0, totalHole = 0, totalStat = 0, totalPos = 0;
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, holesPlayed = 0;

  for (const starter of lineup) {
    const calc = await calculatePlayerPoints(tournamentId, starter.player_name, scoringConfig);
    totalPoints += calc.points;
    totalHole += calc.hole_points;
    totalStat += calc.stat_points;
    totalPos += calc.position_points || 0;
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
    position_points: +totalPos.toFixed(2),
    eagles, birdies, pars, bogeys, doubles_or_worse: doubles, holes_played: holesPlayed,
  };
}

// Process end-of-week: calculate all weekly points, assign positions, award season points
async function processWeeklyResults(leagueId, tournamentId) {
  // Snapshot raw player results (league-agnostic, idempotent)
  await snapshotTournamentResults(tournamentId);

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

  // Skip weeks where every team scored 0 (no one set a lineup)
  const allZero = results.every(r => r.points === 0);
  if (allZero) {
    console.log(`[Scoring] Skipping tournament ${tournamentId} for league ${leagueId} — all teams scored 0`);
    // Clean up any previously stored bad results for this week
    await supabase
      .from('weekly_results')
      .delete()
      .eq('league_id', leagueId)
      .eq('tournament_id', tournamentId);
    await supabase
      .from('season_scores')
      .delete()
      .eq('league_id', leagueId)
      .eq('tournament_id', tournamentId);
    return [];
  }

  results.sort((a, b) => b.points - a.points);

  // Assign positions and season points with tie handling:
  // Tied teams share the same position (e.g. T2) and split the combined
  // season points for the positions they span, like prize money in golf.
  let i = 0;
  while (i < results.length) {
    // Find the extent of the tie group starting at position i
    let j = i + 1;
    while (j < results.length && results[j].points === results[i].points) {
      j++;
    }
    const tiedCount = j - i;
    // Sum the season points for positions i through j-1 and divide evenly
    let totalSeasonPts = 0;
    for (let k = i; k < j; k++) {
      totalSeasonPts += seasonPointsDist[k] || seasonPointsDist[seasonPointsDist.length - 1] || 25;
    }
    const sharedPts = +(totalSeasonPts / tiedCount).toFixed(2);
    const position = i + 1; // 1-indexed position

    for (let k = i; k < j; k++) {
      results[k].position = position;
      results[k].seasonPoints = sharedPts;
    }
    i = j;
  }

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

  // Fetch ALL data for the tournament in parallel, match in memory (case-insensitive)
  // hole_scores can exceed Supabase's 1000-row default limit, so paginate
  async function fetchAllHoles(tid) {
    let all = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data } = await supabase.from('hole_scores')
        .select('player_name, score, par')
        .eq('tournament_id', tid)
        .range(from, from + PAGE - 1);
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  const [allHoles, { data: allStats }, { data: fieldAvg }, { data: allPositions }] = await Promise.all([
    fetchAllHoles(tournamentId),
    supabase.from('tournament_stats').select('*').eq('tournament_id', tournamentId),
    supabase.from('tournament_field_averages').select('*').eq('tournament_id', tournamentId).maybeSingle(),
    supabase.from('player_scores').select('player_name, position').eq('tournament_id', tournamentId),
  ]);

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

  const positionByPlayer = {};
  for (const p of allPositions || []) {
    positionByPlayer[p.player_name.toLowerCase()] = p.position;
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

    const posResult = calcPositionPoints(positionByPlayer[key], scoring);

    results[name] = {
      points: +(holeResult.points + statPoints + posResult.position_points).toFixed(2),
      hole_points: holeResult.points,
      stat_points: statPoints,
      stat_breakdown: breakdown,
      position_points: posResult.position_points,
      position: posResult.position,
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

// Snapshot all player results for a tournament into the master player_tournament_results table
// This is league-agnostic — stores raw hole counts + raw stat values + field averages
async function snapshotTournamentResults(tournamentId) {
  // Fetch all hole scores (paginated)
  let allHoles = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data } = await supabase.from('hole_scores')
      .select('player_name, score, par')
      .eq('tournament_id', tournamentId)
      .range(from, from + PAGE - 1);
    allHoles = allHoles.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }

  // Fetch stats, field averages, and positions
  const [{ data: allStats }, { data: fieldAvg }, { data: allPositions }] = await Promise.all([
    supabase.from('tournament_stats').select('*').eq('tournament_id', tournamentId),
    supabase.from('tournament_field_averages').select('*').eq('tournament_id', tournamentId).maybeSingle(),
    supabase.from('player_scores').select('player_name, position').eq('tournament_id', tournamentId),
  ]);

  // Build position lookup
  const positionMap = {};
  for (const p of allPositions || []) {
    positionMap[p.player_name] = p.position;
  }

  // Build hole counts per player
  const playerHoles = {};
  for (const h of allHoles) {
    const key = h.player_name;
    if (!playerHoles[key]) playerHoles[key] = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_or_worse: 0, holes_played: 0 };
    if (h.score === null) continue;
    playerHoles[key].holes_played++;
    const diff = h.score - h.par;
    if (diff <= -2) playerHoles[key].eagles++;
    else if (diff === -1) playerHoles[key].birdies++;
    else if (diff === 0) playerHoles[key].pars++;
    else if (diff === 1) playerHoles[key].bogeys++;
    else playerHoles[key].doubles_or_worse++;
  }

  // Build stats lookup
  const statsMap = {};
  for (const s of allStats || []) {
    statsMap[s.player_name] = s;
  }

  // Get all unique player names from holes and stats
  const allPlayers = new Set([...Object.keys(playerHoles), ...Object.keys(statsMap)]);

  const rows = [];
  for (const name of allPlayers) {
    const holes = playerHoles[name] || { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_or_worse: 0, holes_played: 0 };
    const stats = statsMap[name] || {};

    rows.push({
      tournament_id: tournamentId,
      player_name: name,
      eagles: holes.eagles,
      birdies: holes.birdies,
      pars: holes.pars,
      bogeys: holes.bogeys,
      doubles_or_worse: holes.doubles_or_worse,
      holes_played: holes.holes_played,
      accuracy: stats.accuracy || null,
      gir: stats.gir || null,
      distance: stats.distance || null,
      great_shots: stats.great_shots || null,
      poor_shots: stats.poor_shots || null,
      field_avg_accuracy: fieldAvg?.avg_accuracy || null,
      field_avg_gir: fieldAvg?.avg_gir || null,
      field_avg_distance: fieldAvg?.avg_distance || null,
      position: positionMap[name] || null,
      updated_at: new Date().toISOString(),
    });
  }

  // Upsert in batches
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await supabase.from('player_tournament_results').upsert(batch, {
      onConflict: 'tournament_id,player_name',
    });
  }

  console.log(`[Snapshot] Saved ${rows.length} player results for tournament ${tournamentId}`);
  return rows.length;
}

module.exports = {
  DEFAULT_SCORING,
  generateSeasonPoints,
  isPlayerLocked,
  calculateWeeklyPoints,
  calculatePlayerPoints,
  calculatePlayerPointsBatch,
  processWeeklyResults,
  snapshotTournamentResults,
  parsePosition,
  calcPositionPoints,
};
