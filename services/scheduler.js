const { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores, syncTeeTimes, syncTournamentStats } = require('./datagolf');
const { processWeeklyResults } = require('./seasonScoring');
const supabase = require('../config/supabase');

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

let intervalId = null;
let lastFinalizedTournamentId = null;

function isTournamentDay() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 4=Thu, 5=Fri, 6=Sat
  return day === 0 || day === 4 || day === 5 || day === 6; // Thu-Sun
}

// Check if a tournament just ended (Monday after tournament Sunday) and finalize results
async function checkAndFinalizeCompletedTournaments() {
  try {
    // Look for the most recent tournament that has scores but is no longer active
    // If it's Monday (day 1) or Tuesday (day 2), finalize the previous week
    const now = new Date();
    const day = now.getUTCDay();
    if (day !== 1 && day !== 2) return; // Only auto-finalize Mon/Tue

    const { data: tournaments } = await supabase
      .from('tournaments')
      .select('id, name')
      .eq('is_active', false)
      .order('id', { ascending: false })
      .limit(1);

    if (!tournaments || tournaments.length === 0) return;
    const lastTournament = tournaments[0];

    // Skip if we already finalized this one
    if (lastFinalizedTournamentId === lastTournament.id) return;

    // Get all season leagues that are active
    const { data: leagues } = await supabase
      .from('leagues')
      .select('id')
      .eq('league_type', 'season')
      .eq('status', 'active');

    for (const league of leagues || []) {
      // Check if already finalized for this tournament
      const { data: existing } = await supabase
        .from('weekly_results')
        .select('id')
        .eq('league_id', league.id)
        .eq('tournament_id', lastTournament.id)
        .limit(1);

      if (existing && existing.length > 0) continue; // Already done

      console.log(`[Scheduler] Finalizing tournament "${lastTournament.name}" for league ${league.id}...`);
      await processWeeklyResults(league.id, lastTournament.id);
      console.log(`[Scheduler] Finalized league ${league.id} for tournament ${lastTournament.id}`);
    }

    lastFinalizedTournamentId = lastTournament.id;
    console.log(`[Scheduler] Auto-finalization complete for tournament "${lastTournament.name}"`);
  } catch (err) {
    console.error('[Scheduler] Auto-finalize error:', err.message);
  }
}

async function tick() {
  const tournamentDay = isTournamentDay();
  const label = tournamentDay ? 'TOURNAMENT DAY' : 'OFF DAY';

  try {
    if (tournamentDay) {
      // Tournament day: sync live scores + hole scores + tournament stats every 5 min
      console.log(`[Scheduler] ${label} — syncing live scores + hole scores + stats...`);
      const { tournamentId } = await syncTournament();
      const [scoreCount, holeCount, statCount] = await Promise.all([
        syncLiveScores(tournamentId),
        syncHoleScores(tournamentId),
        syncTournamentStats(tournamentId).catch(err => { console.error('Stats sync:', err.message); return 0; }),
      ]);
      console.log(`[Scheduler] Synced ${scoreCount} live scores, ${holeCount} hole scores, ${statCount} player stats`);
    } else {
      // Off day: sync field/tournament info + tee times + check for finalization
      console.log(`[Scheduler] ${label} — syncing tournament field + tee times...`);
      const { tournamentId, field } = await syncTournament();
      const teeCount = await syncTeeTimes(tournamentId, field);
      console.log(`[Scheduler] Tournament info updated, ${teeCount} tee times synced`);

      // Check if we need to finalize last week's results
      await checkAndFinalizeCompletedTournaments();
    }
  } catch (err) {
    console.error(`[Scheduler] Sync failed:`, err.message);
  }
}

function start() {
  // Run a full sync on server boot
  console.log('[Scheduler] Running initial full sync...');
  syncAll()
    .then(result => {
      console.log(`[Scheduler] Initial sync complete: ${result.tournament}, ${result.playersWithStats} players, ${result.playersWithScores} scores`);
    })
    .catch(err => {
      console.error('[Scheduler] Initial sync failed:', err.message);
    });

  // Schedule: 5 min on tournament days, 1 hour on off days
  function scheduleNext() {
    const delay = isTournamentDay() ? FIVE_MINUTES : ONE_HOUR;
    intervalId = setTimeout(async () => {
      await tick();
      scheduleNext();
    }, delay);
  }

  scheduleNext();
  console.log('[Scheduler] Auto-sync scheduler started');
}

function stop() {
  if (intervalId) {
    clearTimeout(intervalId);
    intervalId = null;
    console.log('[Scheduler] Scheduler stopped');
  }
}

module.exports = { start, stop };
