const { syncAll, syncTournament, syncPlayerStats, syncLiveScores, syncHoleScores, syncTeeTimes } = require('./datagolf');

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

let intervalId = null;

function isTournamentDay() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 4=Thu, 5=Fri, 6=Sat
  return day === 0 || day === 4 || day === 5 || day === 6; // Thu-Sun
}

async function tick() {
  const tournamentDay = isTournamentDay();
  const label = tournamentDay ? 'TOURNAMENT DAY' : 'OFF DAY';

  try {
    if (tournamentDay) {
      // Tournament day: sync live scores + tournament info every 5 min
      console.log(`[Scheduler] ${label} — syncing live scores + hole scores...`);
      const { tournamentId } = await syncTournament();
      const [scoreCount, holeCount] = await Promise.all([
        syncLiveScores(tournamentId),
        syncHoleScores(tournamentId),
      ]);
      console.log(`[Scheduler] Synced ${scoreCount} live scores, ${holeCount} hole scores`);
    } else {
      // Off day: sync field/tournament info + tee times
      console.log(`[Scheduler] ${label} — syncing tournament field + tee times...`);
      const { tournamentId, field } = await syncTournament();
      const teeCount = await syncTeeTimes(tournamentId, field);
      console.log(`[Scheduler] Tournament info updated, ${teeCount} tee times synced`);
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
