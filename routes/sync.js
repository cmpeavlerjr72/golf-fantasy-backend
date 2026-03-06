const express = require('express');
const auth = require('../middleware/auth');
const { syncAll, syncPlayerStats, syncLiveScores, syncTournament } = require('../services/datagolf');

const router = express.Router();

let lastSync = null;
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minute cooldown

// POST /api/sync — Full sync (tournament + stats + scores)
router.post('/', auth, async (req, res) => {
  if (lastSync && Date.now() - lastSync < COOLDOWN_MS) {
    const secsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastSync)) / 1000);
    return res.status(429).json({ error: `Please wait ${secsLeft}s before syncing again` });
  }

  try {
    lastSync = Date.now();
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// POST /api/sync/scores — Live scores only (lighter, faster)
router.post('/scores', auth, async (req, res) => {
  try {
    const { tournamentId } = await syncTournament();
    const count = await syncLiveScores(tournamentId);
    res.json({ scoresUpdated: count, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Score sync error:', err);
    res.status(500).json({ error: 'Score sync failed: ' + err.message });
  }
});

// POST /api/sync/stats — Player stats only (pre-tournament)
router.post('/stats', auth, async (req, res) => {
  try {
    const count = await syncPlayerStats();
    res.json({ statsUpdated: count, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Stats sync error:', err);
    res.status(500).json({ error: 'Stats sync failed: ' + err.message });
  }
});

module.exports = router;
