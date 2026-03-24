const { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores, syncTeeTimes, syncTournamentStats } = require('./datagolf');
const { processWeeklyResults } = require('./seasonScoring');
const { sendLineupReminders, sendFinalizationNotifications } = require('./notifications');
const supabase = require('../config/supabase');

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

let intervalId = null;
let notificationIntervalId = null;

function isTournamentDay() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 4=Thu, 5=Fri, 6=Sat
  return day === 0 || day === 4 || day === 5 || day === 6; // Thu-Sun
}

// Check for any completed tournaments that haven't been finalized yet
async function checkAndFinalizeCompletedTournaments() {
  try {
    // Find tournaments whose end_date has passed (by at least 6 hours for safety)
    // and that are not currently active — these need finalization
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const { data: completedTournaments } = await supabase
      .from('tournaments')
      .select('id, name, end_date')
      .eq('is_active', false)
      .lte('end_date', cutoff)
      .order('id', { ascending: false });

    if (!completedTournaments || completedTournaments.length === 0) return;

    // Get all season leagues that are active
    const { data: leagues } = await supabase
      .from('leagues')
      .select('id')
      .eq('league_type', 'season')
      .eq('status', 'active');

    if (!leagues || leagues.length === 0) return;

    for (const tournament of completedTournaments) {
      for (const league of leagues) {
        // Check if already finalized for this tournament
        const { data: existing } = await supabase
          .from('weekly_results')
          .select('id')
          .eq('league_id', league.id)
          .eq('tournament_id', tournament.id)
          .limit(1);

        if (existing && existing.length > 0) continue; // Already done

        // Verify this tournament actually has scoring data to finalize
        const { data: hasScores } = await supabase
          .from('hole_scores')
          .select('id')
          .eq('tournament_id', tournament.id)
          .limit(1);

        if (!hasScores || hasScores.length === 0) continue; // No data to finalize

        console.log(`[Scheduler] Finalizing tournament "${tournament.name}" for league ${league.id}...`);
        await processWeeklyResults(league.id, tournament.id);
        console.log(`[Scheduler] Finalized league ${league.id} for tournament ${tournament.id}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Auto-finalize error:', err.message);
  }
}

async function tick() {
  const tournamentDay = isTournamentDay();
  const label = tournamentDay ? 'TOURNAMENT DAY' : 'OFF DAY';

  try {
    if (tournamentDay) {
      // Tournament day: sync tournament info, then live data only if actually started
      console.log(`[Scheduler] ${label} — syncing tournament info...`);
      const { tournamentId } = await syncTournament();

      // Verify the tournament has actually started before syncing live scores
      const { data: tourney } = await supabase
        .from('tournaments')
        .select('status')
        .eq('id', tournamentId)
        .single();

      if (tourney?.status === 'in_progress') {
        const [scoreCount, holeCount, statCount] = await Promise.all([
          syncLiveScores(tournamentId),
          syncHoleScores(tournamentId),
          syncTournamentStats(tournamentId).catch(err => { console.error('Stats sync:', err.message); return 0; }),
        ]);
        console.log(`[Scheduler] Synced ${scoreCount} live scores, ${holeCount} hole scores, ${statCount} player stats`);
      } else {
        console.log(`[Scheduler] Tournament not started yet — skipping live score sync`);
      }
    } else {
      // Off day: sync field/tournament info + tee times
      try {
        console.log(`[Scheduler] ${label} — syncing tournament field + tee times...`);
        const { tournamentId, field } = await syncTournament();
        const teeCount = await syncTeeTimes(tournamentId, field);
        console.log(`[Scheduler] Tournament info updated, ${teeCount} tee times synced`);
      } catch (syncErr) {
        console.error(`[Scheduler] Sync failed (finalization will still run):`, syncErr.message);
      }

      // Always check for pending finalizations, even if sync failed above
      await checkAndFinalizeCompletedTournaments();
    }
  } catch (err) {
    console.error(`[Scheduler] Tick failed:`, err.message);
  }
}

// Check if it's time to send scheduled notifications
// Lineup reminder: Wednesday 6pm ET (22:00 UTC during EDT, 23:00 UTC during EST)
// Finalization: Monday 8am ET (12:00 UTC during EDT, 13:00 UTC during EST)
async function checkScheduledNotifications() {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon, 3=Wed
  const utcHour = now.getUTCHours();

  // Wednesday 6pm ET = UTC 22:00 (EDT) or 23:00 (EST)
  if (utcDay === 3 && (utcHour === 22 || utcHour === 23)) {
    console.log('[Scheduler] Sending lineup reminders (Wednesday 6pm ET)...');
    await sendLineupReminders();
  }

  // Monday 8am ET = UTC 12:00 (EDT) or 13:00 (EST)
  if (utcDay === 1 && (utcHour === 12 || utcHour === 13)) {
    console.log('[Scheduler] Sending finalization notifications (Monday 8am ET)...');
    await sendFinalizationNotifications();
  }
}

function start() {
  // Run a full sync on server boot, then check for any missed finalizations
  console.log('[Scheduler] Running initial full sync...');
  syncAll()
    .then(result => {
      console.log(`[Scheduler] Initial sync complete: ${result.tournament}, ${result.playersWithStats} players, ${result.playersWithScores} scores`);
    })
    .catch(err => {
      console.error('[Scheduler] Initial sync failed:', err.message);
    })
    .finally(() => {
      // Always check for pending finalizations on boot, regardless of sync result
      checkAndFinalizeCompletedTournaments()
        .then(() => console.log('[Scheduler] Boot finalization check complete'))
        .catch(err => console.error('[Scheduler] Boot finalization check failed:', err.message));
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

  // Check for scheduled notifications every 30 minutes
  notificationIntervalId = setInterval(async () => {
    try {
      await checkScheduledNotifications();
    } catch (err) {
      console.error('[Scheduler] Notification check error:', err.message);
    }
  }, 30 * 60 * 1000);

  console.log('[Scheduler] Auto-sync scheduler started');
}

function stop() {
  if (intervalId) {
    clearTimeout(intervalId);
    intervalId = null;
  }
  if (notificationIntervalId) {
    clearInterval(notificationIntervalId);
    notificationIntervalId = null;
  }
  console.log('[Scheduler] Scheduler stopped');
}

module.exports = { start, stop };
