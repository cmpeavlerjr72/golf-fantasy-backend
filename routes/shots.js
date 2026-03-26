const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');
const cache = require('../services/cache');

const router = express.Router();

// GET /api/shots/:playerName/round/:round — Get shot-by-shot data for a player's round
router.get('/:playerName/round/:round', auth, async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.playerName);
    const round = parseInt(req.params.round);

    // Cache for 60 seconds (shot data updates every 15 min from local sync)
    const cacheKey = `shots:${playerName}:${round}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Find PGA player ID from mapping
    const { data: mapping } = await supabase
      .from('pga_player_mapping')
      .select('pga_player_id, pga_display_name')
      .eq('dg_player_name', playerName)
      .maybeSingle();

    if (!mapping) {
      return res.json({ available: false, message: 'No shot data available for this player' });
    }

    // Get active tournament's PGA ID
    const { data: tourney } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!tourney) {
      return res.json({ available: false, message: 'No active tournament' });
    }

    const { data: tournMapping } = await supabase
      .from('pga_tournament_mapping')
      .select('pga_tournament_id, tournament_name')
      .eq('tournament_id', tourney.id)
      .maybeSingle();

    if (!tournMapping) {
      return res.json({ available: false, message: 'No shot data available for this tournament' });
    }

    const pgaTournId = tournMapping.pga_tournament_id;
    const pgaPlayerId = mapping.pga_player_id;

    // Get shot details
    const { data: shots } = await supabase
      .from('pga_shot_details')
      .select('*')
      .eq('pga_tournament_id', pgaTournId)
      .eq('pga_player_id', pgaPlayerId)
      .eq('round', round)
      .order('hole_number')
      .order('stroke_number');

    if (!shots || shots.length === 0) {
      return res.json({ available: false, message: 'No shot data for this round yet' });
    }

    // Get commentary
    const { data: commentary } = await supabase
      .from('pga_shot_commentary')
      .select('hole, shot, commentary')
      .eq('pga_tournament_id', pgaTournId)
      .eq('pga_player_id', pgaPlayerId)
      .eq('round', round);

    const commMap = {};
    for (const c of commentary || []) {
      commMap[`${c.hole}_${c.shot}`] = c.commentary;
    }

    // Get hole overlays
    const { data: overlays } = await supabase
      .from('pga_hole_overlays')
      .select('*')
      .eq('pga_tournament_id', pgaTournId)
      .order('hole_number');

    const overlayMap = {};
    for (const o of overlays || []) {
      overlayMap[o.hole_number] = o;
    }

    // Group shots by hole
    const holesMap = {};
    for (const s of shots) {
      if (!holesMap[s.hole_number]) {
        const overlay = overlayMap[s.hole_number] || {};
        holesMap[s.hole_number] = {
          holeNumber: s.hole_number,
          par: s.par,
          score: s.hole_score,
          yardage: s.hole_yardage,
          overlayFullUrl: overlay.overlay_full_url || null,
          overlayGreenUrl: overlay.overlay_green_url || null,
          tee: overlay.tee_enhanced_x != null ? { x: overlay.tee_enhanced_x, y: overlay.tee_enhanced_y } : null,
          pin: overlay.pin_enhanced_x != null ? { x: overlay.pin_enhanced_x, y: overlay.pin_enhanced_y } : null,
          pinGreen: overlay.pin_green_enhanced_x != null ? { x: overlay.pin_green_enhanced_x, y: overlay.pin_green_enhanced_y } : null,
          strokes: [],
        };
      }

      holesMap[s.hole_number].strokes.push({
        strokeNumber: s.stroke_number,
        playByPlay: s.play_by_play,
        distance: s.distance,
        distanceRemaining: s.distance_remaining,
        strokeType: s.stroke_type,
        fromLocation: s.from_location,
        toLocation: s.to_location,
        finalStroke: s.final_stroke,
        from: s.enhanced_x != null ? { x: s.enhanced_x, y: s.enhanced_y } : null,
        to: s.enhanced_to_x != null ? { x: s.enhanced_to_x, y: s.enhanced_to_y } : null,
        greenFrom: s.green_enhanced_x != null ? { x: s.green_enhanced_x, y: s.green_enhanced_y } : null,
        greenTo: s.green_enhanced_to_x != null ? { x: s.green_enhanced_to_x, y: s.green_enhanced_to_y } : null,
        radar: s.club_speed ? {
          clubSpeed: s.club_speed,
          ballSpeed: s.ball_speed,
          smashFactor: s.smash_factor,
          launchSpin: s.launch_spin,
          launchAngle: s.launch_angle,
          apexHeight: s.apex_height,
        } : null,
        commentary: commMap[`${s.hole_number}_${s.stroke_number}`] || null,
      });
    }

    const holes = Object.values(holesMap).sort((a, b) => a.holeNumber - b.holeNumber);

    // Compute round total
    const totalScore = holes.reduce((s, h) => s + parseInt(h.score || 0), 0);
    const totalPar = holes.reduce((s, h) => s + (h.par || 0), 0);
    const diff = totalScore - totalPar;
    const scoreStr = diff === 0 ? 'E' : (diff > 0 ? `+${diff}` : `${diff}`);

    const result = {
      available: true,
      player: mapping.pga_display_name,
      playerName,
      tournament: tournMapping.tournament_name,
      round,
      totalScore,
      scoreToPar: scoreStr,
      holesCompleted: holes.filter(h => h.strokes.some(s => s.finalStroke)).length,
      totalStrokes: shots.length,
      holes,
    };

    cache.set(cacheKey, result, 60_000);
    res.json(result);
  } catch (err) {
    console.error('Shot details error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/shots/:playerName/rounds — Get available rounds for a player
router.get('/:playerName/rounds', auth, async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.playerName);

    const { data: mapping } = await supabase
      .from('pga_player_mapping')
      .select('pga_player_id')
      .eq('dg_player_name', playerName)
      .maybeSingle();

    if (!mapping) {
      return res.json({ available: false, rounds: [] });
    }

    const { data: tourney } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!tourney) return res.json({ available: false, rounds: [] });

    const { data: tournMapping } = await supabase
      .from('pga_tournament_mapping')
      .select('pga_tournament_id')
      .eq('tournament_id', tourney.id)
      .maybeSingle();

    if (!tournMapping) return res.json({ available: false, rounds: [] });

    const { data: statuses } = await supabase
      .from('pga_sync_status')
      .select('round, status, stroke_count')
      .eq('pga_tournament_id', tournMapping.pga_tournament_id)
      .eq('pga_player_id', mapping.pga_player_id)
      .order('round');

    res.json({
      available: true,
      rounds: (statuses || []).map(s => ({
        round: s.round,
        strokeCount: s.stroke_count,
        complete: s.status === 'completed',
      })),
    });
  } catch (err) {
    console.error('Shot rounds error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
