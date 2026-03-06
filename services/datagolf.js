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

// Full sync: tournament + stats + live scores + hole scores
async function syncAll() {
  const { tournamentId, eventName } = await syncTournament();
  const statsCount = await syncPlayerStats();
  const scoresCount = await syncLiveScores(tournamentId);
  const holeCount = await syncHoleScores(tournamentId);

  return {
    tournament: eventName,
    tournamentId,
    playersWithStats: statsCount,
    playersWithScores: scoresCount,
    holeScoresSynced: holeCount,
    syncedAt: new Date().toISOString(),
  };
}

module.exports = { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores };
