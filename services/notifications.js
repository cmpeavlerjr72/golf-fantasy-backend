const { Expo } = require('expo-server-sdk');
const supabase = require('../config/supabase');

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
});

/**
 * Send push notifications to specific users
 * @param {number[]} userIds - Array of user IDs to notify
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {object} data - Optional extra data payload
 */
async function sendToUsers(userIds, title, body, data = {}) {
  if (!userIds || userIds.length === 0) {
    console.log('[Notifications] sendToUsers called with no userIds');
    return;
  }

  console.log(`[Notifications] Sending "${title}" to userIds: ${userIds.join(', ')}`);

  const { data: tokens, error: tokenError } = await supabase
    .from('push_tokens')
    .select('token, user_id')
    .in('user_id', userIds);

  if (tokenError) {
    console.error('[Notifications] Error querying push_tokens:', tokenError.message);
    return;
  }

  if (!tokens || tokens.length === 0) {
    console.warn(`[Notifications] No push tokens found for userIds: ${userIds.join(', ')}`);
    return;
  }

  console.log(`[Notifications] Found ${tokens.length} push token(s)`);

  const messages = [];
  for (const { token } of tokens) {
    if (!Expo.isExpoPushToken(token)) {
      console.warn(`[Notifications] Invalid token skipped: ${token}`);
      continue;
    }
    messages.push({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      channelId: 'default',
    });
  }

  if (messages.length === 0) {
    console.warn('[Notifications] No valid tokens to send to');
    return;
  }

  // Chunk and send
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log(`[Notifications] Send result:`, JSON.stringify(receipts));
      // Clean up invalid tokens
      for (let i = 0; i < receipts.length; i++) {
        if (receipts[i].status === 'error') {
          console.error(`[Notifications] Receipt error for ${chunk[i].to}:`, receipts[i].message, receipts[i].details);
          if (receipts[i].details?.error === 'DeviceNotRegistered') {
            await supabase.from('push_tokens').delete().eq('token', chunk[i].to);
            console.log(`[Notifications] Removed invalid token: ${chunk[i].to}`);
          }
        }
      }
    } catch (err) {
      console.error('[Notifications] Send error:', err.message);
    }
  }
}

/**
 * Send to all members of a league (optionally excluding some users)
 */
async function sendToLeague(leagueId, title, body, data = {}, excludeUserIds = []) {
  const { data: members } = await supabase
    .from('league_members')
    .select('user_id')
    .eq('league_id', leagueId);

  if (!members) return;

  const userIds = members
    .map(m => m.user_id)
    .filter(id => !excludeUserIds.includes(id));

  await sendToUsers(userIds, title, body, { ...data, leagueId });
}

// --- Specific notification helpers ---

async function notifyDraftStarted(leagueId, leagueName) {
  await sendToLeague(
    leagueId,
    'Draft Started!',
    `The draft for ${leagueName} has begun. Get in there!`,
    { type: 'draft_started', leagueId }
  );
}

async function notifyDraftTurn(leagueId, userId, leagueName) {
  await sendToUsers(
    [userId],
    "It's Your Pick!",
    `Your turn to draft in ${leagueName}. Don't keep everyone waiting!`,
    { type: 'draft_turn', leagueId }
  );
}

async function notifyTradeProposed(leagueId, targetUserId, proposerTeam, proposerPlayer, targetPlayer) {
  await sendToUsers(
    [targetUserId],
    'Trade Proposal',
    `${proposerTeam} wants to trade ${proposerPlayer} for your ${targetPlayer}`,
    { type: 'trade_proposed', leagueId }
  );
}

async function notifyTradeAccepted(leagueId, proposerUserId, accepterTeam) {
  await sendToUsers(
    [proposerUserId],
    'Trade Accepted!',
    `${accepterTeam} accepted your trade proposal`,
    { type: 'trade_accepted', leagueId }
  );
}

async function notifyTradeDeclined(leagueId, proposerUserId, declinerTeam) {
  await sendToUsers(
    [proposerUserId],
    'Trade Declined',
    `${declinerTeam} declined your trade proposal`,
    { type: 'trade_declined', leagueId }
  );
}

/**
 * Send lineup lock reminder to all members of active season leagues
 * Scheduled for Wednesday 6pm ET
 */
async function sendLineupReminders() {
  try {
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('name')
      .eq('is_active', true)
      .maybeSingle();

    if (!tournament) return;

    const { data: leagues } = await supabase
      .from('leagues')
      .select('id, name')
      .eq('league_type', 'season')
      .eq('status', 'active');

    if (!leagues || leagues.length === 0) return;

    for (const league of leagues) {
      await sendToLeague(
        league.id,
        'Set Your Lineup!',
        `${tournament.name} starts Thursday. Make sure your lineup is set for ${league.name}!`,
        { type: 'lineup_reminder', leagueId: league.id }
      );
    }

    console.log(`[Notifications] Sent lineup reminders for ${leagues.length} leagues`);
  } catch (err) {
    console.error('[Notifications] Lineup reminder error:', err.message);
  }
}

/**
 * Send tournament finalized notification to all members
 * Scheduled for Monday 8am ET
 */
async function sendFinalizationNotifications() {
  try {
    // Find tournaments finalized in the last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: recentResults } = await supabase
      .from('weekly_results')
      .select('league_id, tournament_id, tournaments(name)')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false });

    if (!recentResults || recentResults.length === 0) return;

    // Group by league to avoid duplicate notifications
    const notified = new Set();
    for (const result of recentResults) {
      const key = `${result.league_id}-${result.tournament_id}`;
      if (notified.has(key)) continue;
      notified.add(key);

      const tournamentName = result.tournaments?.name || 'the tournament';

      const { data: league } = await supabase
        .from('leagues')
        .select('name')
        .eq('id', result.league_id)
        .maybeSingle();

      await sendToLeague(
        result.league_id,
        'Scores Finalized!',
        `${tournamentName} results are in for ${league?.name || 'your league'}. Check the standings!`,
        { type: 'scores_finalized', leagueId: result.league_id }
      );
    }

    console.log(`[Notifications] Sent finalization notifications for ${notified.size} league-tournaments`);
  } catch (err) {
    console.error('[Notifications] Finalization notification error:', err.message);
  }
}

module.exports = {
  sendToUsers,
  sendToLeague,
  notifyDraftStarted,
  notifyDraftTurn,
  notifyTradeProposed,
  notifyTradeAccepted,
  notifyTradeDeclined,
  sendLineupReminders,
  sendFinalizationNotifications,
};
