const supabase = require('../config/supabase');

const DG_BASE = 'https://feeds.datagolf.com';
const DG_KEY = process.env.DATAGOLF_API_KEY;

// Fuzzy-match tournament names — DG may use slightly different casing/formatting
// (e.g. "THE PLAYERS Championship" vs "The Players Championship")
function namesMatch(a, b) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a) === normalize(b);
}

async function dgFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${DG_BASE}${path}${sep}file_format=json&key=${DG_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`DataGolf ${path}: ${res.status}`);
  return res.json();
}

// Sync the current tournament field + create/update tournament record
async function syncTournament() {
  const field = await dgFetch('/field-updates?tour=pga');

  // Upsert tournament — use .limit(1) instead of .maybeSingle() to handle
  // any pre-existing duplicates gracefully (maybeSingle errors on >1 row,
  // which would cascade into creating even more duplicates)
  const { data: existingRows } = await supabase
    .from('tournaments')
    .select('id')
    .eq('name', field.event_name)
    .eq('year', new Date(field.date_start).getFullYear())
    .order('id', { ascending: false })
    .limit(1);
  const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;

  let tournamentId;
  // Determine status from start_date — DG's current_round can be stale
  // (still showing last week's data before the new tournament begins)
  const startDate = field.date_start ? new Date(field.date_start) : null;
  const now = new Date();
  const hasStarted = startDate && now >= startDate;
  const newStatus = hasStarted ? 'in_progress' : 'upcoming';

  if (existing) {
    // Only deactivate OTHER tournaments if we're switching to a different one
    await supabase
      .from('tournaments')
      .update({ is_active: false })
      .eq('is_active', true)
      .neq('id', existing.id);

    await supabase
      .from('tournaments')
      .update({
        start_date: field.date_start,
        end_date: field.date_end,
        is_active: true,
        status: newStatus,
      })
      .eq('id', existing.id);
    tournamentId = existing.id;

    // If tournament hasn't started yet, clear any stale scoring data
    // But ONLY if it doesn't already have finalized results (weekly_results) or a snapshot
    if (newStatus === 'upcoming') {
      const { data: hasResults } = await supabase
        .from('player_tournament_results')
        .select('id')
        .eq('tournament_id', tournamentId)
        .limit(1);

      if (!hasResults || hasResults.length === 0) {
        console.log(`[Sync] Tournament "${field.event_name}" is upcoming — clearing stale scoring data for ID ${tournamentId}`);
        await Promise.all([
          supabase.from('hole_scores').delete().eq('tournament_id', tournamentId),
          supabase.from('player_scores').delete().eq('tournament_id', tournamentId),
          supabase.from('tournament_stats').delete().eq('tournament_id', tournamentId),
          supabase.from('tournament_field_averages').delete().eq('tournament_id', tournamentId),
        ]);
      } else {
        console.log(`[Sync] Tournament "${field.event_name}" marked upcoming but has snapshot data — skipping data clear`);
      }
    }
  } else {
    // New tournament — deactivate all others before inserting
    await supabase
      .from('tournaments')
      .update({ is_active: false })
      .eq('is_active', true);

    const { data: newTourney } = await supabase
      .from('tournaments')
      .insert({
        name: field.event_name,
        year: new Date(field.date_start).getFullYear(),
        start_date: field.date_start,
        end_date: field.date_end,
        is_active: true,
        status: newStatus,
      })
      .select()
      .single();
    tournamentId = newTourney.id;
  }

  return { tournamentId, eventName: field.event_name, field: field.field };
}

// Sync player stats: rankings + skill decompositions + pre-tournament predictions
async function syncPlayerStats() {
  const [rankings, skills, preds] = await Promise.all([
    dgFetch('/preds/get-dg-rankings'),
    dgFetch('/preds/skill-ratings'),
    dgFetch('/preds/pre-tournament').catch(() => ({ baseline: [] })),
  ]);

  // Build lookup maps by dg_id
  const skillMap = new Map();
  for (const p of skills.players || []) {
    skillMap.set(p.dg_id, p);
  }

  const predMap = new Map();
  for (const p of preds.baseline || []) {
    predMap.set(p.dg_id, p);
  }

  const rows = [];
  for (const r of rankings.rankings || []) {
    const sk = skillMap.get(r.dg_id) || {};
    const pr = predMap.get(r.dg_id) || {};

    rows.push({
      player_name: r.player_name,
      owgr_rank: r.owgr_rank,
      dg_rank: r.datagolf_rank,
      primary_tour: r.primary_tour || null,
      sg_total: sk.sg_total ?? null,
      sg_ott: sk.sg_ott ?? null,
      sg_app: sk.sg_app ?? null,
      sg_arg: sk.sg_arg ?? null,
      sg_putt: sk.sg_putt ?? null,
      driving_acc: sk.driving_acc ?? null,
      driving_dist: sk.driving_dist ?? null,
      win_pct: pr.win ? +(pr.win * 100).toFixed(2) : null,
      top5_pct: pr.top_5 ? +(pr.top_5 * 100).toFixed(2) : null,
      top10_pct: pr.top_10 ? +(pr.top_10 * 100).toFixed(2) : null,
      top20_pct: pr.top_20 ? +(pr.top_20 * 100).toFixed(2) : null,
      updated_at: new Date().toISOString(),
    });
  }

  // Atomic upsert — no gap where player data disappears
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('player_stats').upsert(batch, {
      onConflict: 'player_name',
    });
    if (error) console.error('Stats upsert error:', error.message);
  }

  return rows.length;
}

// Sync live scores from in-play predictions
async function syncLiveScores(tournamentId) {
  // Look up the expected tournament name so we can verify the DG response matches
  const { data: tourney } = await supabase
    .from('tournaments')
    .select('name')
    .eq('id', tournamentId)
    .single();

  const live = await dgFetch('/preds/in-play');

  // Guard: if DG's in-play data is for a different tournament (e.g. still showing
  // last week's results), skip the sync to avoid tagging stale scores with the
  // wrong tournament ID.  Also clear any contaminated scores from prior syncs
  // that ran before this guard existed.
  if (tourney?.name && live.event_name && !namesMatch(tourney.name, live.event_name)) {
    console.log(`[Sync] Skipping live scores — DG in-play is for "${live.event_name}" but active tournament is "${tourney.name}"`);
    // Clear any stale scores that were previously written under this tournament ID
    const { data: stale } = await supabase
      .from('player_scores')
      .select('id')
      .eq('tournament_id', tournamentId)
      .limit(1);
    if (stale && stale.length > 0) {
      console.log(`[Sync] Clearing stale player_scores for tournament ${tournamentId}`);
      await supabase.from('player_scores').delete().eq('tournament_id', tournamentId);
    }
    return 0;
  }

  const rows = (live.data || []).map((p, i) => ({
    tournament_id: tournamentId,
    player_name: p.player_name,
    position: p.current_pos || null,
    score_to_par: p.current_score ?? null,
    thru: p.thru != null ? String(p.thru === 0 && p.end_hole === 18 ? 'F' : p.thru) : null,
    today: p.today ?? null,
    round1: p.R1 ?? null,
    round2: p.R2 ?? null,
    round3: p.R3 ?? null,
    round4: p.R4 ?? null,
    updated_at: new Date().toISOString(),
  }));

  // Atomic upsert — no gap where scores disappear
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('player_scores').upsert(batch, {
      onConflict: 'tournament_id,player_name',
    });
    if (error) console.error('Scores upsert error:', error.message);
  }

  return rows.length;
}

// Sync hole-by-hole scores from live-hole-scores endpoint
async function syncHoleScores(tournamentId) {
  const { data: tourney } = await supabase
    .from('tournaments')
    .select('name')
    .eq('id', tournamentId)
    .single();

  const data = await dgFetch('/preds/live-hole-scores?tour=pga');

  // Guard: skip if DG is still serving data for last week's tournament
  if (tourney?.name && data.event_name && !namesMatch(tourney.name, data.event_name)) {
    console.log(`[Sync] Skipping hole scores — DG is for "${data.event_name}" but active tournament is "${tourney.name}"`);
    const { data: stale } = await supabase
      .from('hole_scores')
      .select('id')
      .eq('tournament_id', tournamentId)
      .limit(1);
    if (stale && stale.length > 0) {
      console.log(`[Sync] Clearing stale hole_scores for tournament ${tournamentId}`);
      await supabase.from('hole_scores').delete().eq('tournament_id', tournamentId);
    }
    return 0;
  }

  const rows = [];
  for (const player of data.players || []) {
    for (const round of player.rounds || []) {
      for (const hole of round.scores || []) {
        rows.push({
          tournament_id: tournamentId,
          player_name: player.player_name,
          dg_id: player.dg_id,
          round_num: round.round_num,
          hole: hole.hole,
          par: hole.par,
          score: hole.score,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  // Upsert atomically — no gap where hole data disappears
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('hole_scores').upsert(batch, {
      onConflict: 'tournament_id,player_name,round_num,hole',
    });
    if (error) console.error('Hole scores upsert error:', error.message);
  }

  return rows.length;
}

// Sync live tournament stats (FIR, GIR, distance, great/poor shots, etc.)
async function syncTournamentStats(tournamentId) {
  const { data: tourney } = await supabase
    .from('tournaments')
    .select('name')
    .eq('id', tournamentId)
    .single();

  const stats = await dgFetch(
    '/preds/live-tournament-stats?stats=accuracy,gir,distance,great_shots,poor_shots,sg_putt,sg_arg,sg_app,sg_ott,sg_total&round=event_avg'
  );

  // Guard: skip if DG is still serving stats for last week's tournament
  if (tourney?.name && stats.event_name && !namesMatch(tourney.name, stats.event_name)) {
    console.log(`[Sync] Skipping tournament stats — DG is for "${stats.event_name}" but active tournament is "${tourney.name}"`);
    const { data: stale } = await supabase
      .from('tournament_stats')
      .select('id')
      .eq('tournament_id', tournamentId)
      .limit(1);
    if (stale && stale.length > 0) {
      console.log(`[Sync] Clearing stale tournament_stats for tournament ${tournamentId}`);
      await Promise.all([
        supabase.from('tournament_stats').delete().eq('tournament_id', tournamentId),
        supabase.from('tournament_field_averages').delete().eq('tournament_id', tournamentId),
      ]);
    }
    return 0;
  }

  // DG returns { live_stats: [ ... ] }
  const players = stats.live_stats;
  if (!players || !Array.isArray(players) || players.length === 0) {
    console.error('No live_stats in tournament stats response. Keys:', Object.keys(stats || {}));
    return 0;
  }

  const rows = [];
  let totalAcc = 0, totalGir = 0, totalDist = 0, totalGreat = 0, totalPoor = 0;
  let countAcc = 0, countGir = 0, countDist = 0, countAll = 0;

  for (const p of players) {
    const row = {
      tournament_id: tournamentId,
      player_name: p.player_name,
      dg_id: p.dg_id,
      accuracy: p.accuracy ?? null,
      gir: p.gir ?? null,
      distance: p.distance ?? null,
      great_shots: p.great_shots ?? null,
      poor_shots: p.poor_shots ?? null,
      sg_putt: p.sg_putt ?? null,
      sg_arg: p.sg_arg ?? null,
      sg_app: p.sg_app ?? null,
      sg_ott: p.sg_ott ?? null,
      sg_total: p.sg_total ?? null,
      thru: p.thru != null ? String(p.thru) : null,
      position: p.position ?? null,
      total_score: p.total ?? null,
      updated_at: new Date().toISOString(),
    };
    rows.push(row);
    countAll++;

    if (p.accuracy != null) { totalAcc += p.accuracy; countAcc++; }
    if (p.gir != null) { totalGir += p.gir; countGir++; }
    if (p.distance != null) { totalDist += p.distance; countDist++; }
    if (p.great_shots != null) totalGreat += p.great_shots;
    if (p.poor_shots != null) totalPoor += p.poor_shots;
  }

  // Upsert player stats atomically
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('tournament_stats').upsert(batch, {
      onConflict: 'tournament_id,player_name',
    });
    if (error) console.error('Tournament stats upsert error:', error.message);
  }

  // Calculate and store field averages
  const avgRow = {
    tournament_id: tournamentId,
    avg_accuracy: countAcc > 0 ? totalAcc / countAcc : null,
    avg_gir: countGir > 0 ? totalGir / countGir : null,
    avg_distance: countDist > 0 ? totalDist / countDist : null,
    avg_great_shots: countAll > 0 ? totalGreat / countAll : null,
    avg_poor_shots: countAll > 0 ? totalPoor / countAll : null,
    player_count: countAll,
    updated_at: new Date().toISOString(),
  };

  await supabase
    .from('tournament_field_averages')
    .upsert(avgRow, { onConflict: 'tournament_id' });

  return rows.length;
}

// Sync tee times from field-updates data into tee_times table
async function syncTeeTimes(tournamentId, fieldData) {
  // If no field data passed, fetch it
  if (!fieldData) {
    const field = await dgFetch('/field-updates?tour=pga');
    fieldData = field.field;
  }

  const rows = [];
  for (const player of fieldData || []) {
    for (const tt of player.teetimes || []) {
      if (!tt.teetime) continue;
      rows.push({
        tournament_id: tournamentId,
        player_name: player.player_name,
        dg_id: player.dg_id,
        round_num: tt.round_num,
        tee_time: tt.teetime,
      });
    }
  }

  // Tee times can change — clear and re-insert (OK here since tee times
  // are not used in scoring, only for lock detection)
  await supabase.from('tee_times').delete().eq('tournament_id', tournamentId);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('tee_times').insert(batch);
    if (error) console.error('Tee times insert error:', error.message);
  }

  return rows.length;
}

// Full sync: tournament + stats + live scores + hole scores + tee times + tournament stats
async function syncAll() {
  const { tournamentId, eventName, field } = await syncTournament();
  const statsCount = await syncPlayerStats();

  // Check if tournament has ACTUALLY started — not just start_date, but whether
  // any round-1 tee time has passed. This prevents syncing stale DG in-play data
  // on the morning of a tournament before anyone has teed off.
  const { data: tourney } = await supabase.from('tournaments').select('status').eq('id', tournamentId).single();
  let isLive = tourney?.status === 'in_progress';

  if (isLive) {
    const { data: earliestTee } = await supabase
      .from('tee_times')
      .select('tee_time')
      .eq('tournament_id', tournamentId)
      .eq('round_num', 1)
      .order('tee_time', { ascending: true })
      .limit(1);

    if (earliestTee && earliestTee.length > 0) {
      const firstTeeTime = new Date(earliestTee[0].tee_time);
      if (new Date() < firstTeeTime) {
        console.log(`[Sync] Tournament "${eventName}" marked in_progress but first tee time is ${earliestTee[0].tee_time} — skipping live scores`);
        isLive = false;
      }
    }
  }

  let scoresCount = 0, holeCount = 0, teeTimeCount = 0, tournStatCount = 0;

  if (isLive) {
    // Sync hole scores FIRST — if no holes have been played, the tournament
    // hasn't truly started and player positions from DG are stale last-week data.
    holeCount = await syncHoleScores(tournamentId);
    tournStatCount = await syncTournamentStats(tournamentId).catch(err => {
      console.error('Tournament stats sync error (may not be live yet):', err.message);
      return 0;
    });

    if (holeCount > 0) {
      scoresCount = await syncLiveScores(tournamentId);
    } else {
      console.log(`[Sync] Tournament "${eventName}" is in_progress but no hole scores from DG yet — skipping leaderboard sync to avoid stale positions`);
      // Clear any stale positions that may have snuck in
      const { data: stale } = await supabase
        .from('player_scores')
        .select('id')
        .eq('tournament_id', tournamentId)
        .limit(1);
      if (stale && stale.length > 0) {
        console.log(`[Sync] Clearing stale player_scores for tournament ${tournamentId}`);
        await supabase.from('player_scores').delete().eq('tournament_id', tournamentId);
      }
    }
  } else {
    console.log(`[Sync] Tournament "${eventName}" is upcoming — skipping live score sync`);
  }

  // Always sync tee times (available before tournament starts)
  teeTimeCount = await syncTeeTimes(tournamentId, field);

  return {
    tournament: eventName,
    tournamentId,
    playersWithStats: statsCount,
    playersWithScores: scoresCount,
    holeScoresSynced: holeCount,
    teeTimesSynced: teeTimeCount,
    tournamentStatsSynced: tournStatCount,
    syncedAt: new Date().toISOString(),
  };
}

// Backfill historical 2026 tournament data into our DB
// Fetches event list + round-level data from DG historical endpoints,
// aggregates into tournament-level results, and stores in player_tournament_results
async function backfillHistoricalTournaments() {
  console.log('[Backfill] Fetching 2026 PGA event list...');
  const eventList = await dgFetch('/historical-raw-data/event-list?tour=pga');

  // Filter to 2026 completed events only (date is in the past)
  const now = new Date();
  const events2026 = (eventList || []).filter(e => {
    const isYear = e.calendar_year === 2026 || String(e.calendar_year) === '2026';
    // Only backfill events that have already finished (date is in the past)
    const eventDate = e.date ? new Date(e.date) : null;
    const isCompleted = eventDate && eventDate < now;
    return isYear && isCompleted;
  });

  if (events2026.length === 0) {
    console.log('[Backfill] No completed 2026 events found');
    return { eventsProcessed: 0 };
  }

  console.log(`[Backfill] Found ${events2026.length} completed events for 2026`);

  const results = [];

  for (const event of events2026) {
    const eventId = event.event_id;
    const eventName = event.event_name;
    console.log(`[Backfill] Processing: ${eventName} (event_id=${eventId})...`);

    // Fetch round-level data for this event
    // Response format: { event_id, event_name, scores: [ { player_name, fin_text, dg_id, round_1: {...}, round_2: {...}, ... } ] }
    let data;
    try {
      data = await dgFetch(`/historical-raw-data/rounds?tour=pga&event_id=${eventId}&year=2026`);
    } catch (err) {
      console.log(`[Backfill] Skipping ${eventName}: ${err.message}`);
      continue;
    }

    const scores = data?.scores;
    if (!scores || !Array.isArray(scores) || scores.length === 0) {
      console.log(`[Backfill] No scores for ${eventName}, skipping`);
      continue;
    }

    // Create or find tournament record
    const { data: existing } = await supabase
      .from('tournaments')
      .select('id')
      .eq('name', eventName)
      .eq('year', 2026)
      .maybeSingle();

    let tournamentId;
    if (existing) {
      tournamentId = existing.id;
    } else {
      const { data: newTourney } = await supabase
        .from('tournaments')
        .insert({
          name: eventName,
          year: 2026,
          start_date: event.date || null,
          is_active: false,
          status: 'completed',
        })
        .select()
        .single();
      tournamentId = newTourney.id;
    }

    // Aggregate per-player data from nested round objects
    // Each player has round_1, round_2, round_3, round_4 with stats per round
    let totalAcc = 0, totalGir = 0, totalDist = 0;
    let countAcc = 0, countGir = 0, countDist = 0;
    let totalGreat = 0, totalPoor = 0, countAll = 0;
    const playerResults = [];

    for (const player of scores) {
      const name = player.player_name;
      if (!name) continue;

      // Collect all rounds for this player (round_1, round_2, round_3, round_4)
      const roundKeys = ['round_1', 'round_2', 'round_3', 'round_4'].filter(k => player[k]);
      if (roundKeys.length === 0) continue;

      let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doublesOrWorse = 0;
      let greatShots = 0, poorShots = 0;
      let sumAcc = 0, sumGir = 0, sumDist = 0;
      let hasAcc = 0, hasGir = 0, hasDist = 0;
      const holesPlayed = roundKeys.length * 18;

      for (const rk of roundKeys) {
        const rd = player[rk];
        eagles += rd.eagles_or_better || 0;
        birdies += rd.birdies || 0;
        pars += rd.pars || 0;
        bogeys += rd.bogies || 0;
        doublesOrWorse += rd.doubles_or_worse || 0;
        greatShots += rd.great_shots || 0;
        poorShots += rd.poor_shots || 0;
        if (rd.driving_acc != null) { sumAcc += rd.driving_acc; hasAcc++; }
        if (rd.gir != null) { sumGir += rd.gir; hasGir++; }
        if (rd.driving_dist != null) { sumDist += rd.driving_dist; hasDist++; }
      }

      const avgAcc = hasAcc > 0 ? sumAcc / hasAcc : null;
      const avgGir = hasGir > 0 ? sumGir / hasGir : null;
      const avgDist = hasDist > 0 ? sumDist / hasDist : null;

      if (avgAcc != null) { totalAcc += avgAcc; countAcc++; }
      if (avgGir != null) { totalGir += avgGir; countGir++; }
      if (avgDist != null) { totalDist += avgDist; countDist++; }
      totalGreat += greatShots;
      totalPoor += poorShots;
      countAll++;

      playerResults.push({
        name,
        fin_text: player.fin_text || null,
        eagles, birdies, pars, bogeys, doublesOrWorse,
        greatShots, poorShots,
        accuracy: avgAcc,
        gir: avgGir,
        distance: avgDist,
        holesPlayed,
      });
    }

    // Calculate field averages
    const fieldAvgAcc = countAcc > 0 ? totalAcc / countAcc : null;
    const fieldAvgGir = countGir > 0 ? totalGir / countGir : null;
    const fieldAvgDist = countDist > 0 ? totalDist / countDist : null;

    // Store field averages
    await supabase
      .from('tournament_field_averages')
      .upsert({
        tournament_id: tournamentId,
        avg_accuracy: fieldAvgAcc,
        avg_gir: fieldAvgGir,
        avg_distance: fieldAvgDist,
        avg_great_shots: countAll > 0 ? totalGreat / countAll : null,
        avg_poor_shots: countAll > 0 ? totalPoor / countAll : null,
        player_count: countAll,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tournament_id' });

    // Build player_tournament_results rows
    const rows = playerResults.map(p => ({
      tournament_id: tournamentId,
      player_name: p.name,
      position: p.fin_text,
      eagles: p.eagles,
      birdies: p.birdies,
      pars: p.pars,
      bogeys: p.bogeys,
      doubles_or_worse: p.doublesOrWorse,
      holes_played: p.holesPlayed,
      accuracy: p.accuracy,
      gir: p.gir,
      distance: p.distance,
      great_shots: p.greatShots,
      poor_shots: p.poorShots,
      field_avg_accuracy: fieldAvgAcc,
      field_avg_gir: fieldAvgGir,
      field_avg_distance: fieldAvgDist,
      updated_at: new Date().toISOString(),
    }));

    // Upsert in batches
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await supabase.from('player_tournament_results').upsert(batch, {
        onConflict: 'tournament_id,player_name',
      });
    }

    console.log(`[Backfill] ${eventName}: ${rows.length} players stored`);
    results.push({ event: eventName, players: rows.length, tournamentId });
  }

  console.log(`[Backfill] Complete! Processed ${results.length} tournaments`);
  return { eventsProcessed: results.length, details: results };
}

module.exports = { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores, syncTeeTimes, syncTournamentStats, backfillHistoricalTournaments };
