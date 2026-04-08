const supabase = require('../config/supabase');
const jwt = require('jsonwebtoken');
const { notifyDraftStarted, notifyDraftTurn } = require('./notifications');

const MAX_CONNECTIONS_PER_USER = 5;
const PICK_COOLDOWN_MS = 1000; // 1 sec between picks

function setupDraftSocket(io) {
  // Track connections per user to prevent abuse
  const userConnections = new Map(); // userId -> count

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;

      // Enforce per-user connection limit
      const count = userConnections.get(decoded.id) || 0;
      if (count >= MAX_CONNECTIONS_PER_USER) {
        return next(new Error('Too many connections'));
      }
      userConnections.set(decoded.id, count + 1);

      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    let lastPickTime = 0;

    socket.on('join-draft', async ({ leagueId }) => {
      try {
        if (!leagueId || typeof leagueId !== 'number') return;

        const { data: member } = await supabase
          .from('league_members')
          .select('*, leagues(*)')
          .eq('league_id', leagueId)
          .eq('user_id', socket.user.id)
          .maybeSingle();

        if (!member) return;

        const room = `draft-${leagueId}`;
        socket.join(room);
        socket.leagueId = leagueId;
        socket.memberId = member.id;

        const state = await getDraftState(leagueId);
        socket.emit('draft-state', state);
      } catch (err) {
        console.error('Join draft error:', err);
      }
    });

    socket.on('start-draft', async ({ leagueId, draftOrder }) => {
      try {
        if (!leagueId || typeof leagueId !== 'number') return;

        const { data: league } = await supabase
          .from('leagues')
          .select('*')
          .eq('id', leagueId)
          .single();

        if (!league) return;
        if (league.owner_id !== socket.user.id) return;
        if (league.status !== 'pre_draft') return;

        // Get members (include draft_order for pinned position detection)
        const { data: members } = await supabase
          .from('league_members')
          .select('id, draft_order')
          .eq('league_id', leagueId);

        if (Array.isArray(draftOrder) && draftOrder.length === members.length) {
          // Commissioner provided a custom draft order (array of member IDs)
          for (let i = 0; i < draftOrder.length; i++) {
            await supabase
              .from('league_members')
              .update({ draft_order: i + 1 })
              .eq('id', draftOrder[i]);
          }
        } else {
          // Check for pinned draft positions (draft_order < 0 means pinned to abs value)
          // e.g. draft_order = -2 means "pin me at position 2"
          const pinned = members.filter(m => m.draft_order != null && m.draft_order < 0);
          const unpinned = members.filter(m => !pinned.some(p => p.id === m.id));

          // Build position map: pinned positions are reserved
          const pinnedMap = new Map(); // position -> member id
          for (const p of pinned) {
            pinnedMap.set(Math.abs(p.draft_order), p.id);
          }

          // Shuffle the unpinned members
          const shuffled = unpinned.sort(() => Math.random() - 0.5);

          // Assign positions: fill in unpinned around the pinned slots
          let unpinnedIdx = 0;
          for (let pos = 1; pos <= members.length; pos++) {
            const memberId = pinnedMap.has(pos)
              ? pinnedMap.get(pos)
              : shuffled[unpinnedIdx++].id;
            await supabase
              .from('league_members')
              .update({ draft_order: pos })
              .eq('id', memberId);
          }
        }

        await supabase
          .from('leagues')
          .update({ status: 'drafting' })
          .eq('id', leagueId);

        const state = await getDraftState(leagueId);
        io.to(`draft-${leagueId}`).emit('draft-state', state);

        // Send push notification to all league members
        console.log(`[Draft] Sending draft started notification for league ${leagueId} (${league.name})`);
        notifyDraftStarted(leagueId, league.name).catch(err =>
          console.error('Draft start notification error:', err.message)
        );

        // Notify the first picker it's their turn
        if (state.currentMemberId) {
          const firstPicker = state.members.find(m => m.id === state.currentMemberId);
          if (firstPicker) {
            console.log(`[Draft] Notifying first picker userId=${firstPicker.userId} for league ${leagueId}`);
            notifyDraftTurn(leagueId, firstPicker.userId, league.name).catch(err =>
              console.error('Draft turn notification error:', err.message)
            );
          }
        }
      } catch (err) {
        console.error('Start draft error:', err);
      }
    });

    socket.on('draft-pick', async ({ leagueId, playerName, playerId }) => {
      try {
        if (!leagueId || !playerName || typeof playerName !== 'string') return;

        // Rate limit picks
        const now = Date.now();
        if (now - lastPickTime < PICK_COOLDOWN_MS) {
          socket.emit('draft-error', { message: 'Too fast, please wait' });
          return;
        }
        lastPickTime = now;

        const { data: league } = await supabase
          .from('leagues')
          .select('*')
          .eq('id', leagueId)
          .single();

        if (!league || league.status !== 'drafting') return;

        const { data: members } = await supabase
          .from('league_members')
          .select('*')
          .eq('league_id', leagueId)
          .order('draft_order');

        const { data: picks } = await supabase
          .from('draft_picks')
          .select('*')
          .eq('league_id', leagueId);

        const currentPick = picks ? picks.length : 0;
        const totalPicks = members.length * league.draft_rounds;

        if (currentPick >= totalPicks) return;

        // Snake draft logic
        const round = Math.floor(currentPick / members.length);
        const posInRound = currentPick % members.length;
        const isReversed = round % 2 === 1;
        const teamIndex = isReversed ? members.length - 1 - posInRound : posInRound;
        const currentMember = members[teamIndex];

        if (currentMember.id !== socket.memberId) return;

        // Check if player already drafted
        const alreadyPicked = (picks || []).some(
          p => p.player_name.toLowerCase() === playerName.toLowerCase()
        );
        if (alreadyPicked) {
          socket.emit('draft-error', { message: 'Player already drafted' });
          return;
        }

        const { error } = await supabase
          .from('draft_picks')
          .insert({
            league_id: leagueId,
            member_id: currentMember.id,
            player_name: playerName,
            player_id: playerId || null,
            round: round + 1,
            pick_number: currentPick + 1,
          });

        if (error) {
          // UNIQUE constraint violation = race condition, another pick landed first
          socket.emit('draft-error', { message: 'Pick failed, please try again' });
          return;
        }

        // Check if draft is complete
        if (currentPick + 1 >= totalPicks) {
          await supabase
            .from('leagues')
            .update({ status: 'active' })
            .eq('id', leagueId);

          // For season leagues, populate rosters from draft picks
          if (league.league_type === 'season') {
            const { data: allPicks } = await supabase
              .from('draft_picks')
              .select('member_id, player_name, player_id')
              .eq('league_id', leagueId);

            const rosterRows = (allPicks || []).map(p => ({
              league_id: leagueId,
              member_id: p.member_id,
              player_name: p.player_name,
              dg_id: p.player_id || null,
              acquired_via: 'draft',
            }));

            if (rosterRows.length > 0) {
              const { error: rosterErr } = await supabase.from('rosters').insert(rosterRows);
              if (rosterErr) console.error('Roster populate error:', rosterErr.message);
            }
          }
        }

        const state = await getDraftState(leagueId);
        io.to(`draft-${leagueId}`).emit('draft-state', state);

        // Notify next picker it's their turn
        if (state.status === 'drafting' && state.currentMemberId) {
          const nextPicker = state.members.find(m => m.id === state.currentMemberId);
          if (nextPicker && nextPicker.userId !== socket.user.id) {
            console.log(`[Draft] Notifying next picker userId=${nextPicker.userId} for league ${leagueId}`);
            notifyDraftTurn(leagueId, nextPicker.userId, league.name).catch(err =>
              console.error('Draft turn notification error:', err.message)
            );
          }
        }
      } catch (err) {
        console.error('Draft pick error:', err);
      }
    });

    socket.on('disconnect', () => {
      // Clean up connection count
      const userId = socket.user?.id;
      if (userId) {
        const count = userConnections.get(userId) || 1;
        if (count <= 1) {
          userConnections.delete(userId);
        } else {
          userConnections.set(userId, count - 1);
        }
      }
    });
  });
}

async function getDraftState(leagueId) {
  const [{ data: league }, { data: members }, { data: picks }] = await Promise.all([
    supabase.from('leagues').select('*').eq('id', leagueId).single(),
    supabase.from('league_members')
      .select('id, team_name, draft_order, user_id, users(display_name)')
      .eq('league_id', leagueId).order('draft_order'),
    supabase.from('draft_picks')
      .select('*, league_members(team_name)')
      .eq('league_id', leagueId).order('pick_number'),
  ]);

  const currentPick = picks ? picks.length : 0;
  const totalPicks = (members || []).length * league.draft_rounds;
  let currentMemberId = null;

  if (league.status === 'drafting' && currentPick < totalPicks) {
    const round = Math.floor(currentPick / members.length);
    const posInRound = currentPick % members.length;
    const isReversed = round % 2 === 1;
    const teamIndex = isReversed ? members.length - 1 - posInRound : posInRound;
    currentMemberId = members[teamIndex].id;
  }

  return {
    status: league.status,
    leagueType: league.league_type,
    tournamentId: league.tournament_id,
    draftRounds: league.draft_rounds,
    currentPick,
    totalPicks,
    currentMemberId,
    members: (members || []).map(m => ({
      id: m.id,
      teamName: m.team_name,
      displayName: m.users?.display_name,
      userId: m.user_id,
      draftOrder: m.draft_order,
    })),
    picks: (picks || []).map(p => ({
      memberId: p.member_id,
      teamName: p.league_members?.team_name,
      playerName: p.player_name,
      round: p.round,
      pickNumber: p.pick_number,
    })),
  };
}

module.exports = setupDraftSocket;
