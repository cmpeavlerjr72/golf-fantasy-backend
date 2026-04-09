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
    console.log(`[Shots] round request — name: "${playerName}" (len=${playerName.length}, codes=${[...playerName].slice(0, 5).map(c => c.codePointAt(0).toString(16))})`);

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
      console.log(`[Shots] NO MAPPING for "${playerName}" — check if flag emoji was included`);
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

    // Detect if this is a Masters tournament (uses masters.com coordinate system)
    const isMasters = pgaTournId === 'R2026014';

    // Masters: use masters.com hole map illustrations as overlay backgrounds.
    // Shot coordinates (xo/yo State Plane) are mapped onto the images using
    // a 2-point affine calibration (tee + pin anchors). The calibration data
    // was determined by visual inspection of each hole-map image.
    //
    // IMPORTANT: The frontend container has aspectRatio=2.34 (PGA pickle ratio)
    // but Masters images are 16:9 (1.778). With resizeMode="contain", the image
    // is letterboxed — it only fills ~76% of the container width, centered.
    // We must remap x-coordinates from image-space to container-space.
    const mastersCalibration = require('../data/masters-hole-calibration.json');
    const CONTAINER_AR = 2.34;
    const MASTERS_IMG_AR = 2880 / 1620; // 1.778
    const IMG_WIDTH_FRAC = MASTERS_IMG_AR / CONTAINER_AR; // ~0.76
    const IMG_X_OFFSET = (1 - IMG_WIDTH_FRAC) / 2; // ~0.12

    // Convert image-normalized coords to container-normalized coords
    function imgToContainer(nx, ny) {
      return {
        x: IMG_X_OFFSET + nx * IMG_WIDTH_FRAC,
        y: ny,
      };
    }

    function mastersCoordTransform(holeNum, overlay, rawStrokes) {
      const cal = mastersCalibration.holes[String(holeNum)];
      if (!cal) return rawStrokes;

      const tXo = overlay.tee_enhanced_x, tYo = overlay.tee_enhanced_y;
      const pXo = overlay.pin_enhanced_x, pYo = overlay.pin_enhanced_y;
      if (tXo == null || pXo == null) return rawStrokes;
      if (tXo === 0 && tYo === 0) return rawStrokes;
      if (pXo === 0 && pYo === 0) return rawStrokes;

      // State Plane tee→pin vector
      const dx = pXo - tXo, dy = pYo - tYo;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) return rawStrokes;
      const ux = dx / len, uy = dy / len; // along-hole unit vector
      const vx = -uy, vy = ux; // perpendicular unit vector

      // Image tee→pin vector
      const pdx = cal.pin.x - cal.tee.x, pdy = cal.pin.y - cal.tee.y;
      const plen = Math.sqrt(pdx * pdx + pdy * pdy);
      const pvx = -pdy / plen, pvy = pdx / plen; // perpendicular in image space

      function toImageNorm(xo, yo) {
        if (xo == null || yo == null) return null;
        const rx = xo - tXo, ry = yo - tYo;
        const along = (rx * ux + ry * uy) / len; // 0=tee, 1=pin
        const cross = (rx * vx + ry * vy) / len; // lateral deviation
        // Compute position in image-space, then remap to container-space
        const imgX = cal.tee.x + along * (cal.pin.x - cal.tee.x) + cross * pvx * plen * 0.5;
        const imgY = cal.tee.y + along * (cal.pin.y - cal.tee.y) + cross * pvy * plen * 0.5;
        return imgToContainer(
          Math.max(0, Math.min(1, imgX)),
          Math.max(0, Math.min(1, imgY))
        );
      }

      const teeNorm = toImageNorm(tXo, tYo);
      return rawStrokes.map((s, i) => {
        const to = toImageNorm(s._rawX, s._rawY);
        const from = i === 0 ? teeNorm : toImageNorm(rawStrokes[i - 1]._rawX, rawStrokes[i - 1]._rawY);
        return { ...s, from, to, greenFrom: null, greenTo: null };
      });
    }

    // Group shots by hole
    const holesMap = {};
    for (const s of shots) {
      if (!holesMap[s.hole_number]) {
        const overlay = overlayMap[s.hole_number] || {};
        const hasValidCoords = isMasters && overlay.tee_enhanced_x && overlay.pin_enhanced_x
          && !(overlay.tee_enhanced_x === 0 && overlay.tee_enhanced_y === 0)
          && !(overlay.pin_enhanced_x === 0 && overlay.pin_enhanced_y === 0);

        let overlayUrl;
        if (isMasters && hasValidCoords && mastersCalibration.holes[String(s.hole_number)]) {
          overlayUrl = `https://www.masters.com/assets/images/course/angc/hole-map-${s.hole_number}.jpg`;
        } else if (isMasters) {
          overlayUrl = null;
        } else {
          overlayUrl = overlay.overlay_full_url || null;
        }

        holesMap[s.hole_number] = {
          holeNumber: s.hole_number,
          par: s.par,
          score: s.hole_score,
          yardage: s.hole_yardage,
          overlayFullUrl: overlayUrl,
          overlayGreenUrl: isMasters ? null : (overlay.overlay_green_url || null),
          tee: overlay.tee_enhanced_x != null ? { x: overlay.tee_enhanced_x, y: overlay.tee_enhanced_y } : null,
          pin: overlay.pin_enhanced_x != null ? { x: overlay.pin_enhanced_x, y: overlay.pin_enhanced_y } : null,
          pinGreen: overlay.pin_green_enhanced_x != null ? { x: overlay.pin_green_enhanced_x, y: overlay.pin_green_enhanced_y } : null,
          _overlay: overlay, // keep raw for transform
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
        _rawX: s.enhanced_x, // preserve for Masters transform
        _rawY: s.enhanced_y,
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

    // Apply Masters coordinate transform if needed
    if (isMasters) {
      for (const hole of Object.values(holesMap)) {
        if (hole._overlay && hole.strokes.length > 0) {
          hole.strokes = mastersCoordTransform(hole.holeNumber, hole._overlay, hole.strokes);
          // Set pin/tee from calibration data
          const cal = mastersCalibration.holes[String(hole.holeNumber)];
          if (cal) {
            hole.pin = imgToContainer(cal.pin.x, cal.pin.y);
            hole.tee = imgToContainer(cal.tee.x, cal.tee.y);
          }
        }
        delete hole._overlay;
        // Clean up internal fields from strokes
        for (const s of hole.strokes) {
          delete s._rawX;
          delete s._rawY;
        }
      }
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
    console.log(`[Shots] rounds request — name: "${playerName}" (len=${playerName.length})`);

    const { data: mapping } = await supabase
      .from('pga_player_mapping')
      .select('pga_player_id')
      .eq('dg_player_name', playerName)
      .maybeSingle();

    if (!mapping) {
      console.log(`[Shots] rounds — NO MAPPING for "${playerName}"`);
      return res.json({ available: false, rounds: [] });
    }

    const { data: tourney } = await supabase
      .from('tournaments')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!tourney) {
      console.log(`[Shots] rounds — no active tournament`);
      return res.json({ available: false, rounds: [] });
    }

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

// GET /api/shots/:playerName/inferred-holes — Get inferred great/poor shot hole associations
router.get('/:playerName/inferred-holes', auth, async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.playerName);
    const tournamentId = parseInt(req.query.tournamentId);

    if (!tournamentId) {
      return res.status(400).json({ error: 'tournamentId query param required' });
    }

    const cacheKey = `inferred-holes:${playerName}:${tournamentId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { data: rows } = await supabase
      .from('inferred_shot_holes')
      .select('round, shot_type, possible_holes, exact')
      .eq('tournament_id', tournamentId)
      .eq('player_name', playerName)
      .order('created_at');

    const result = { great_shots: [], poor_shots: [] };
    for (const r of (rows || [])) {
      const entry = { round: r.round, possible_holes: r.possible_holes, exact: r.exact };
      if (r.shot_type === 'great') result.great_shots.push(entry);
      else if (r.shot_type === 'poor') result.poor_shots.push(entry);
    }

    cache.set(cacheKey, result, 60_000);
    res.json(result);
  } catch (err) {
    console.error('Inferred holes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
