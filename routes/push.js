const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

// POST /api/push/register — Register a push token
router.post('/register', auth, async (req, res) => {
  const { token, platform } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  try {
    // Upsert: if this user+token combo already exists, just update
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { user_id: req.user.id, token, platform: platform || null },
        { onConflict: 'user_id,token' }
      );

    if (error) throw error;
    res.json({ message: 'Push token registered' });
  } catch (err) {
    console.error('Push register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/push/unregister — Remove a push token (on logout)
router.delete('/unregister', auth, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  try {
    await supabase
      .from('push_tokens')
      .delete()
      .eq('user_id', req.user.id)
      .eq('token', token);

    res.json({ message: 'Push token removed' });
  } catch (err) {
    console.error('Push unregister error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/push/version — App version check
router.get('/version', (req, res) => {
  res.json({
    minVersion: '1.2.0',
    latestVersion: '1.2.0',
    forceUpdate: false,
    storeUrls: {
      ios: 'https://apps.apple.com/us/app/fairway-fantasy/id6760315596',
      android: 'https://play.google.com/store/apps/details?id=com.fairwayfantasy.app&hl=en_US',
    },
  });
});

module.exports = router;
