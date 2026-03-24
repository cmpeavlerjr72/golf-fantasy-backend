const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');
const { isPlayerLocked } = require('../services/seasonScoring');
const { notifyTradeProposed, notifyTradeAccepted, notifyTradeDeclined } = require('../services/notifications');

const router = express.Router();

// POST /api/trades/:leagueId — Propose a trade
router.post('/:leagueId', auth, async (req, res) => {
  const { myPlayer, theirPlayer, theirMemberId } = req.body;

  if (!myPlayer || !theirPlayer || !theirMemberId) {
    return res.status(400).json({ error: 'myPlayer, theirPlayer, and theirMemberId are required' });
  }

  try {
    const { data: league } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', req.params.leagueId)
      .maybeSingle();

    if (!league || league.league_type !== 'season') {
      return res.status(400).json({ error: 'Trades only available in season leagues' });
    }

    const { data: myMember } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!myMember) return res.status(403).json({ error: 'Not a member' });

    // Verify both players are on correct rosters
    const { data: myRoster } = await supabase
      .from('rosters')
      .select('id')
      .eq('league_id', league.id)
      .eq('member_id', myMember.id)
      .ilike('player_name', myPlayer)
      .maybeSingle();

    if (!myRoster) return res.status(400).json({ error: `${myPlayer} is not on your roster` });

    const { data: theirRoster } = await supabase
      .from('rosters')
      .select('id')
      .eq('league_id', league.id)
      .eq('member_id', theirMemberId)
      .ilike('player_name', theirPlayer)
      .maybeSingle();

    if (!theirRoster) return res.status(400).json({ error: `${theirPlayer} is not on their roster` });

    // Check tee time locks
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (tournament) {
      const myLocked = await isPlayerLocked(tournament.id, myPlayer);
      const theirLocked = await isPlayerLocked(tournament.id, theirPlayer);
      if (myLocked) return res.status(400).json({ error: `${myPlayer} is locked (tee time passed)` });
      if (theirLocked) return res.status(400).json({ error: `${theirPlayer} is locked (tee time passed)` });
    }

    const { data: proposal, error } = await supabase
      .from('trade_proposals')
      .insert({
        league_id: league.id,
        proposer_id: myMember.id,
        proposer_player: myPlayer,
        target_id: theirMemberId,
        target_player: theirPlayer,
      })
      .select()
      .single();

    if (error) throw error;

    // Notify the target user about the trade proposal
    const { data: targetMember } = await supabase
      .from('league_members')
      .select('user_id, team_name')
      .eq('id', myMember.id)
      .maybeSingle();

    const { data: targetUser } = await supabase
      .from('league_members')
      .select('user_id')
      .eq('id', theirMemberId)
      .maybeSingle();

    if (targetUser) {
      notifyTradeProposed(
        league.id,
        targetUser.user_id,
        targetMember?.team_name || 'Someone',
        myPlayer,
        theirPlayer
      ).catch(err => console.error('Trade propose notification error:', err.message));
    }

    res.status(201).json({ id: proposal.id, message: 'Trade proposed' });
  } catch (err) {
    console.error('Propose trade error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/trades/:leagueId — List trades (pending + recent)
router.get('/:leagueId', auth, async (req, res) => {
  try {
    // Verify league membership
    const { data: member } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', req.params.leagueId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!member) return res.status(403).json({ error: 'Not a member of this league' });

    const { data } = await supabase
      .from('trade_proposals')
      .select(`
        *,
        proposer:league_members!trade_proposals_proposer_id_fkey(team_name, users(display_name)),
        target:league_members!trade_proposals_target_id_fkey(team_name, users(display_name))
      `)
      .eq('league_id', req.params.leagueId)
      .order('created_at', { ascending: false })
      .limit(20);

    res.json((data || []).map(t => ({
      id: t.id,
      status: t.status,
      proposerTeam: t.proposer?.team_name,
      proposerPlayer: t.proposer_player,
      targetTeam: t.target?.team_name,
      targetPlayer: t.target_player,
      createdAt: t.created_at,
      resolvedAt: t.resolved_at,
    })));
  } catch (err) {
    console.error('List trades error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trades/:leagueId/:tradeId/accept
router.post('/:leagueId/:tradeId/accept', auth, async (req, res) => {
  try {
    const { data: trade } = await supabase
      .from('trade_proposals')
      .select('*')
      .eq('id', req.params.tradeId)
      .eq('league_id', req.params.leagueId)
      .eq('status', 'pending')
      .maybeSingle();

    if (!trade) return res.status(404).json({ error: 'Trade not found or already resolved' });

    // Verify the accepting user is the target
    const { data: member } = await supabase
      .from('league_members')
      .select('id, team_name')
      .eq('id', trade.target_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!member) return res.status(403).json({ error: 'Only the trade target can accept' });

    // Check tee time locks again at accept time
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (tournament) {
      const lock1 = await isPlayerLocked(tournament.id, trade.proposer_player);
      const lock2 = await isPlayerLocked(tournament.id, trade.target_player);
      if (lock1 || lock2) {
        return res.status(400).json({ error: 'One or both players are now locked' });
      }
    }

    // Swap players on rosters
    await supabase
      .from('rosters')
      .update({ player_name: trade.target_player, acquired_via: 'trade', acquired_at: new Date().toISOString() })
      .eq('league_id', trade.league_id)
      .eq('member_id', trade.proposer_id)
      .ilike('player_name', trade.proposer_player);

    await supabase
      .from('rosters')
      .update({ player_name: trade.proposer_player, acquired_via: 'trade', acquired_at: new Date().toISOString() })
      .eq('league_id', trade.league_id)
      .eq('member_id', trade.target_id)
      .ilike('player_name', trade.target_player);

    // Mark trade as accepted
    await supabase
      .from('trade_proposals')
      .update({ status: 'accepted', resolved_at: new Date().toISOString() })
      .eq('id', trade.id);

    // Log transactions
    await supabase.from('transactions').insert([
      { league_id: trade.league_id, member_id: trade.proposer_id, type: 'trade', player_name: `Sent ${trade.proposer_player}, received ${trade.target_player}` },
      { league_id: trade.league_id, member_id: trade.target_id, type: 'trade', player_name: `Sent ${trade.target_player}, received ${trade.proposer_player}` },
    ]);

    // Notify the proposer their trade was accepted
    const { data: proposerMember } = await supabase
      .from('league_members')
      .select('user_id')
      .eq('id', trade.proposer_id)
      .maybeSingle();

    if (proposerMember) {
      notifyTradeAccepted(trade.league_id, proposerMember.user_id, member.team_name || 'Your trade partner')
        .catch(err => console.error('Trade accept notification error:', err.message));
    }

    res.json({ message: 'Trade accepted' });
  } catch (err) {
    console.error('Accept trade error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trades/:leagueId/:tradeId/decline
router.post('/:leagueId/:tradeId/decline', auth, async (req, res) => {
  try {
    const { data: trade } = await supabase
      .from('trade_proposals')
      .select('*')
      .eq('id', req.params.tradeId)
      .eq('league_id', req.params.leagueId)
      .eq('status', 'pending')
      .maybeSingle();

    if (!trade) return res.status(404).json({ error: 'Trade not found or already resolved' });

    const { data: member } = await supabase
      .from('league_members')
      .select('id, team_name')
      .eq('id', trade.target_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!member) return res.status(403).json({ error: 'Only the trade target can decline' });

    await supabase
      .from('trade_proposals')
      .update({ status: 'declined', resolved_at: new Date().toISOString() })
      .eq('id', trade.id);

    // Notify the proposer their trade was declined
    const { data: proposerMember } = await supabase
      .from('league_members')
      .select('user_id')
      .eq('id', trade.proposer_id)
      .maybeSingle();

    if (proposerMember) {
      notifyTradeDeclined(trade.league_id, proposerMember.user_id, member.team_name || 'Your trade partner')
        .catch(err => console.error('Trade decline notification error:', err.message));
    }

    res.json({ message: 'Trade declined' });
  } catch (err) {
    console.error('Decline trade error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
