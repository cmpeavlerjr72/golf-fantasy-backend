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

    // Masters: generate an SVG data URI as the overlay image with shots
    // pre-rendered. No external imagery — we own every pixel, so the
    // coordinate math is guaranteed correct. The frontend still gets
    // normalized from/to coords for its interactive highlight layer.
    const MASTERS_SVG_W = 800, MASTERS_SVG_H = 500;

    function mastersComputeBbox(overlay, strokes) {
      const tXo = overlay.tee_enhanced_x, tYo = overlay.tee_enhanced_y;
      const pXo = overlay.pin_enhanced_x, pYo = overlay.pin_enhanced_y;
      if (tXo == null || pXo == null) return null;
      if (tXo === 0 && tYo === 0) return null;
      if (pXo === 0 && pYo === 0) return null;

      const xs = [tXo, pXo], ys = [tYo, pYo];
      for (const s of strokes) {
        if (s._rawX != null) { xs.push(s._rawX); ys.push(s._rawY); }
      }
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const span = Math.max(xMax - xMin, yMax - yMin) || 200;
      const pad = span * 0.18;
      return { xoMin: xMin - pad, xoMax: xMax + pad, yoMin: yMin - pad, yoMax: yMax + pad };
    }

    function mastersToNorm(xo, yo, bbox) {
      if (xo == null || yo == null || !bbox) return null;
      return {
        x: Math.max(0, Math.min(1, (xo - bbox.xoMin) / (bbox.xoMax - bbox.xoMin))),
        y: Math.max(0, Math.min(1, (bbox.yoMax - yo) / (bbox.yoMax - bbox.yoMin))),
      };
    }

    function mastersCoordTransform(holeNum, overlay, rawStrokes) {
      const bbox = mastersComputeBbox(overlay, rawStrokes);
      if (!bbox) return rawStrokes;
      const teeN = mastersToNorm(overlay.tee_enhanced_x, overlay.tee_enhanced_y, bbox);
      return rawStrokes.map((s, i) => {
        const to = mastersToNorm(s._rawX, s._rawY, bbox);
        const from = i === 0 ? teeN : mastersToNorm(rawStrokes[i - 1]._rawX, rawStrokes[i - 1]._rawY, bbox);
        return { ...s, from, to, greenFrom: null, greenTo: null };
      });
    }

    function mastersBuildOverlaySvg(hole, overlay, strokes) {
      const bbox = mastersComputeBbox(overlay, strokes);
      if (!bbox) return null;
      const W = MASTERS_SVG_W, H = MASTERS_SVG_H;
      const n = (xo, yo) => mastersToNorm(xo, yo, bbox);

      const teeN = n(overlay.tee_enhanced_x, overlay.tee_enhanced_y);
      const pinN = n(overlay.pin_enhanced_x, overlay.pin_enhanced_y);
      const tPx = teeN ? teeN.x * W : 0, tPy = teeN ? teeN.y * H : 0;
      const pPx = pinN ? pinN.x * W : W, pPy = pinN ? pinN.y * H : H;
      const cx = (tPx + pPx) / 2, cy = (tPy + pPy) / 2;
      const dist = Math.sqrt((pPx - tPx) ** 2 + (pPy - tPy) ** 2);
      const ang = Math.atan2(pPy - tPy, pPx - tPx) * 180 / Math.PI;

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
      svg += `<rect width="${W}" height="${H}" fill="#1a3a1a"/>`;
      svg += `<ellipse cx="${cx}" cy="${cy}" rx="${dist * 0.55}" ry="${dist * 0.22}" fill="#2d5a2d" transform="rotate(${ang},${cx},${cy})"/>`;
      svg += `<ellipse cx="${cx}" cy="${cy}" rx="${dist * 0.48}" ry="${dist * 0.12}" fill="#3a7a3a" transform="rotate(${ang},${cx},${cy})"/>`;
      if (pinN) svg += `<circle cx="${pPx}" cy="${pPy}" r="${Math.max(18, dist * 0.06)}" fill="#4a9a4a"/>`;
      if (teeN) svg += `<rect x="${tPx - 8}" y="${tPy - 5}" width="16" height="10" fill="#5a8a5a" rx="2" transform="rotate(${ang},${tPx},${tPy})"/>`;

      // Shot trail
      const pts = [];
      if (teeN) pts.push({ x: tPx, y: tPy });
      for (const s of hole.strokes) {
        if (s.to) pts.push({ x: s.to.x * W, y: s.to.y * H });
      }
      if (pts.length > 1) {
        svg += `<polyline points="${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-dasharray="6,4"/>`;
      }
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const isFirst = i === 0;
        const isLast = i === pts.length - 1 && hole.strokes[hole.strokes.length - 1]?.finalStroke;
        const clr = isFirst ? '#FFD700' : isLast ? '#FF4444' : '#FFFFFF';
        svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isFirst || isLast ? 6 : 4}" fill="${clr}" stroke="#000" stroke-width="1"/>`;
        if (isFirst) svg += `<text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" fill="#FFD700" font-size="11" font-family="sans-serif" font-weight="bold" text-anchor="middle">TEE</text>`;
      }
      if (pinN) svg += `<text x="${pPx}" y="${pPy - 22}" fill="#FF4444" font-size="11" font-family="sans-serif" font-weight="bold" text-anchor="middle">PIN</text>`;
      svg += `<text x="10" y="20" fill="rgba(255,255,255,0.6)" font-size="12" font-family="sans-serif">Hole ${hole.holeNumber} · Par ${hole.par} · ${hole.yardage} yds</text>`;
      svg += '</svg>';
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    // Group shots by hole
    const holesMap = {};
    for (const s of shots) {
      if (!holesMap[s.hole_number]) {
        const overlay = overlayMap[s.hole_number] || {};
        const hasValidCoords = isMasters && overlay.tee_enhanced_x && overlay.pin_enhanced_x
          && !(overlay.tee_enhanced_x === 0 && overlay.tee_enhanced_y === 0)
          && !(overlay.pin_enhanced_x === 0 && overlay.pin_enhanced_y === 0);

        // For the Masters, overlayUrl is set to a placeholder — the actual
        // SVG data URI is generated after shots are grouped and transformed
        let overlayUrl;
        if (isMasters) {
          overlayUrl = hasValidCoords ? 'MASTERS_SVG_PENDING' : null;
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
          // Generate SVG overlay with shots baked in
          const bbox = mastersComputeBbox(hole._overlay, hole.strokes);
          if (bbox) {
            hole.overlayFullUrl = mastersBuildOverlaySvg(hole, hole._overlay, hole.strokes);
            hole.pin = mastersToNorm(hole._overlay.pin_enhanced_x, hole._overlay.pin_enhanced_y, bbox);
            hole.tee = mastersToNorm(hole._overlay.tee_enhanced_x, hole._overlay.tee_enhanced_y, bbox);
          } else {
            hole.overlayFullUrl = null;
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
