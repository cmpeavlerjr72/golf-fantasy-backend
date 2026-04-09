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

    // Detect if this is a Masters tournament (uses masters.com coordinate system)
    const isMasters = pgaTournId === 'R2026014';

    // Masters shot coords are Georgia State Plane xo/yo (NAD83 US feet).
    // We serve ESRI satellite images with a matching bounding box.
    //
    // CRITICAL: The bbox must be aspect-ratio-adjusted to match the image
    // dimensions (1200x800 = 3:2). Otherwise ESRI stretches the image and
    // the coordinate mapping breaks.
    const MASTERS_IMG_W = 1200, MASTERS_IMG_H = 800;
    const MASTERS_ASPECT = MASTERS_IMG_W / MASTERS_IMG_H; // 1.5

    function mastersGetBbox(overlay) {
      const teeXo = overlay.tee_enhanced_x;
      const teeYo = overlay.tee_enhanced_y;
      const pinXo = overlay.pin_enhanced_x;
      const pinYo = overlay.pin_enhanced_y;

      if (teeXo == null || pinXo == null) return null;
      if (teeXo === 0 && teeYo === 0) return null;
      if (pinXo === 0 && pinYo === 0) return null;

      // Base bbox with 25% padding
      const padX = Math.abs(pinXo - teeXo) * 0.25 || 100;
      const padY = Math.abs(pinYo - teeYo) * 0.25 || 100;
      let xoMin = Math.min(teeXo, pinXo) - padX;
      let xoMax = Math.max(teeXo, pinXo) + padX;
      let yoMin = Math.min(teeYo, pinYo) - padY;
      let yoMax = Math.max(teeYo, pinYo) + padY;

      // Adjust to match image aspect ratio (3:2)
      const spW = xoMax - xoMin;
      const spH = yoMax - yoMin;
      const curRatio = spW / spH;
      if (curRatio < MASTERS_ASPECT) {
        const newW = spH * MASTERS_ASPECT;
        const cx = (xoMin + xoMax) / 2;
        xoMin = cx - newW / 2;
        xoMax = cx + newW / 2;
      } else {
        const newH = spW / MASTERS_ASPECT;
        const cy = (yoMin + yoMax) / 2;
        yoMin = cy - newH / 2;
        yoMax = cy + newH / 2;
      }

      return { xoMin, xoMax, yoMin, yoMax };
    }

    function mastersCoordTransform(holeNum, overlay, rawStrokes) {
      const bbox = mastersGetBbox(overlay);
      if (!bbox) return rawStrokes;

      const { xoMin, xoMax, yoMin, yoMax } = bbox;
      const xoRange = xoMax - xoMin;
      const yoRange = yoMax - yoMin;

      function toNorm(xo, yo) {
        if (xo == null || yo == null) return null;
        return {
          x: Math.max(0, Math.min(1, (xo - xoMin) / xoRange)),
          y: Math.max(0, Math.min(1, (yoMax - yo) / yoRange)),
        };
      }

      const teeNorm = toNorm(overlay.tee_enhanced_x, overlay.tee_enhanced_y);

      return rawStrokes.map((s, i) => {
        const shotPos = toNorm(s._rawX, s._rawY);
        const prevPos = i === 0 ? teeNorm : toNorm(rawStrokes[i - 1]._rawX, rawStrokes[i - 1]._rawY);
        return {
          ...s,
          from: prevPos,
          to: shotPos,
          greenFrom: null,
          greenTo: null,
        };
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

        // For the Masters, generate the ESRI satellite image URL using the
        // same aspect-ratio-adjusted bbox that the coordinate transform uses
        let overlayUrl;
        if (isMasters && hasValidCoords) {
          const bbox = mastersGetBbox(overlay);
          if (bbox) {
            const proj4 = require('proj4');
            const GA_SP = '+proj=tmerc +lat_0=30 +lon_0=-82.16666666666667 +k=0.9999 +x_0=200000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs';
            const [w, s2] = proj4(GA_SP, 'EPSG:4326', [bbox.xoMin, bbox.yoMin]);
            const [e2, n] = proj4(GA_SP, 'EPSG:4326', [bbox.xoMax, bbox.yoMax]);
            overlayUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${w},${s2},${e2},${n}&bboxSR=4326&size=${MASTERS_IMG_W},${MASTERS_IMG_H}&format=png&f=image`;
          } else {
            overlayUrl = null;
          }
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
          // Normalize pin and tee positions using same bbox
          const bbox = mastersGetBbox(hole._overlay);
          if (bbox) {
            const { xoMin, xoMax, yoMin, yoMax } = bbox;
            const xr = xoMax - xoMin, yr = yoMax - yoMin;
            const o = hole._overlay;
            hole.pin = {
              x: (o.pin_enhanced_x - xoMin) / xr,
              y: (yoMax - o.pin_enhanced_y) / yr,
            };
            hole.tee = {
              x: (o.tee_enhanced_x - xoMin) / xr,
              y: (yoMax - o.tee_enhanced_y) / yr,
            };
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
