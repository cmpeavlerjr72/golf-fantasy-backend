const supabase = require('../config/supabase');

const DG_BASE = 'https://feeds.datagolf.com';
const DG_KEY = process.env.DATAGOLF_API_KEY;

async function dgFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${DG_BASE}${path}${sep}file_format=json&key=${DG_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DataGolf ${path}: ${res.status}`);
  return res.json();
}

// Sync the current tournament field + create/update tournament record
async function syncTournament() {
  const field = await dgFetch('/field-updates?tour=pga');

  // Upsert tournament
  const { data: existing } = await supabase
    .from('tournaments')
    .select('id')
    .eq('name', field.event_name)
    .eq('year', new Date(field.date_start).getFullYear())
    .maybeSingle();

  let tournamentId;
  if (existing) {
    await supabase
      .from('tournaments')
      .update({
        start_date: field.date_start,
        end_date: field.date_end,
        is_active: true,
        status: field.current_round > 0 ? 'in_progress' : 'upcoming',
      })
      .eq('id', existing.id);
    tournamentId = existing.id;
  } else {
    // Deactivate all other tournaments
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
        status: field.current_round > 0 ? 'in_progress' : 'upcoming',
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

  // Clear existing stats and insert fresh
  await supabase.from('player_stats').delete().neq('id', 0);

  const rows = [];
  for (const r of rankings.rankings || []) {
    const sk = skillMap.get(r.dg_id) || {};
    const pr = predMap.get(r.dg_id) || {};

    rows.push({
      player_name: r.player_name,
      owgr_rank: r.owgr_rank,
      dg_rank: r.datagolf_rank,
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

  // Insert in batches of 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('player_stats').insert(batch);
    if (error) console.error('Stats insert error:', error.message);
  }

  return rows.length;
}

// Sync live scores from in-play predictions
async function syncLiveScores(tournamentId) {
  const live = await dgFetch('/preds/in-play');

  // Clear existing scores for this tournament
  await supabase.from('player_scores').delete().eq('tournament_id', tournamentId);

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

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('player_scores').insert(batch);
    if (error) console.error('Scores insert error:', error.message);
  }

  return rows.length;
}

// Sync hole-by-hole scores from live-hole-scores endpoint
async function syncHoleScores(tournamentId) {
  const data = await dgFetch('/preds/live-hole-scores?tour=pga');

  // Clear existing hole scores for this tournament
  await supabase.from('hole_scores').delete().eq('tournament_id', tournamentId);

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

  // Insert in batches of 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('hole_scores').insert(batch);
    if (error) console.error('Hole scores insert error:', error.message);
  }

  return rows.length;
}

// Sync live tournament stats (FIR, GIR, distance, great/poor shots, etc.)
async function syncTournamentStats(tournamentId) {
  const stats = await dgFetch(
    '/preds/live-tournament-stats?stats=accuracy,gir,distance,great_shots,poor_shots,sg_putt,sg_arg,sg_app,sg_ott,sg_total&round=event_avg'
  );

  // Clear existing stats for this tournament
  await supabase.from('tournament_stats').delete().eq('tournament_id', tournamentId);

  const rows = [];
  let totalAcc = 0, totalGir = 0, totalDist = 0, totalGreat = 0, totalPoor = 0;
  let countAcc = 0, countGir = 0, countDist = 0, countAll = 0;

  for (const p of stats.data || stats || []) {
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

  // Insert player stats in batches
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('tournament_stats').insert(batch);
    if (error) console.error('Tournament stats insert error:', error.message);
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

  // Clear existing tee times for this tournament
  await supabase.from('tee_times').delete().eq('tournament_id', tournamentId);

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

  // Insert in batches of 500
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
  const scoresCount = await syncLiveScores(tournamentId);
  const holeCount = await syncHoleScores(tournamentId);
  const teeTimeCount = await syncTeeTimes(tournamentId, field);
  const tournStatCount = await syncTournamentStats(tournamentId).catch(err => {
    console.error('Tournament stats sync error (may not be live yet):', err.message);
    return 0;
  });

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

module.exports = { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores, syncTeeTimes, syncTournamentStats };
