const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data: user, error } = await supabase
      .from('users')
      .insert({ email, password_hash: passwordHash, display_name: displayName })
      .select('id, email, display_name')
      .single();

    if (error) throw error;

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      token,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/auth/account
router.delete('/account', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get all league_members for this user
    const { data: members } = await supabase
      .from('league_members')
      .select('id')
      .eq('user_id', userId);

    const memberIds = (members || []).map(m => m.id);

    if (memberIds.length > 0) {
      // 2. Delete trade proposals involving this user's memberships
      await supabase
        .from('trade_proposals')
        .delete()
        .in('proposer_id', memberIds);
      await supabase
        .from('trade_proposals')
        .delete()
        .in('target_id', memberIds);

      // 3. Delete transactions for this user's memberships
      await supabase
        .from('transactions')
        .delete()
        .in('member_id', memberIds);

      // 4. Delete league_members (cascades: draft_picks, rosters, lineups, season_scores, weekly_results)
      await supabase
        .from('league_members')
        .delete()
        .eq('user_id', userId);
    }

    // 5. Delete leagues owned by this user
    const { data: ownedLeagues } = await supabase
      .from('leagues')
      .select('id')
      .eq('owner_id', userId);

    if (ownedLeagues && ownedLeagues.length > 0) {
      const leagueIds = ownedLeagues.map(l => l.id);

      // Delete all members of owned leagues (cascades their dependent data)
      await supabase
        .from('league_members')
        .delete()
        .in('league_id', leagueIds);

      await supabase
        .from('leagues')
        .delete()
        .eq('owner_id', userId);
    }

    // 6. Delete the user
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, display_name')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ id: user.id, email: user.email, displayName: user.display_name });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
