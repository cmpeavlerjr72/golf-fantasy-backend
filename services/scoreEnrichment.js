// Score enrichment — adds tee times, country flags, and position movement
// to standings/leaderboard responses WITHOUT any frontend changes.
// All modifications are done by decorating string fields the frontend already renders.

const supabase = require('../config/supabase');

// ─── Position tracking (in-memory) ─────────────────────────────────────────
// Stores previous positions keyed by player name so we can compute movement
const prevPositions = new Map();

function parsePosition(pos) {
  if (!pos || pos === '-') return null;
  // Strip leading T for ties, arrows, etc — just get the number
  const m = String(pos).match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function getMovementArrow(playerName, currentPos) {
  const cur = parsePosition(currentPos);
  if (cur === null) return '';
  const prev = prevPositions.get(playerName);
  if (prev === null || prev === undefined) return '';
  if (cur < prev) return '\u{1F7E2}\u2191'; // green circle + up arrow (moved up)
  if (cur > prev) return '\u{1F534}\u2193'; // red circle + down arrow (moved down)
  return '';
}

function updatePositionCache(players) {
  for (const p of players) {
    const num = parsePosition(p.position);
    if (num !== null) {
      prevPositions.set(p.playerName || p.player_name, num);
    }
  }
}

// ─── Country flag emoji mapping ─────────────────────────────────────────────
// ISO 3166-1 alpha-2 -> flag emoji is done by offsetting chars into regional indicator range
// But masters/DG use 3-letter codes, so we map those to 2-letter ISO first
const COUNTRY_3_TO_2 = {
  USA: 'US', SWE: 'SE', ENG: 'GB', AUS: 'AU', ARG: 'AR', DEN: 'DK',
  CAN: 'CA', JPN: 'JP', RSA: 'ZA', KOR: 'KR', ESP: 'ES', IRL: 'IE',
  NOR: 'NO', COL: 'CO', GER: 'DE', FRA: 'FR', ITA: 'IT', CHN: 'CN',
  THA: 'TH', MEX: 'MX', GBR: 'GB', NZL: 'NZ', FIJ: 'FJ', AUT: 'AT',
  ZIM: 'ZW', IND: 'IN', TWN: 'TW', CHI: 'CL', PAR: 'PY', BEL: 'BE',
  POL: 'PL', PHI: 'PH', SCO: 'GB', NIR: 'GB', WAL: 'GB', PUR: 'PR',
  VEN: 'VE', TAI: 'TW', BER: 'BM', FIN: 'FI', NED: 'NL', POR: 'PT',
  CRC: 'CR', URU: 'UY', HON: 'HN', SIN: 'SG', MAS: 'MY', HKG: 'HK',
};

function countryToFlag(code3) {
  const code2 = COUNTRY_3_TO_2[code3];
  if (!code2) return '';
  // Regional indicator symbols: A=0x1F1E6, B=0x1F1E7, etc.
  const c1 = 0x1F1E6 + code2.charCodeAt(0) - 65;
  const c2 = 0x1F1E6 + code2.charCodeAt(1) - 65;
  return String.fromCodePoint(c1, c2);
}

// ─── Masters 2026 player countries (embedded to avoid external file dep) ────
const MASTERS_2026_COUNTRIES = {
  "ludvig aberg": "SWE", "daniel berger": "USA", "akshay bhatia": "USA",
  "keegan bradley": "USA", "michael brennan": "USA", "jacob bridgeman": "USA",
  "sam burns": "USA", "angel cabrera": "ARG", "brian campbell": "USA",
  "patrick cantlay": "USA", "wyndham clark": "USA", "corey conners": "CAN",
  "fred couples": "USA", "jason day": "AUS", "bryson dechambeau": "USA",
  "nicolas echavarria": "COL", "harris english": "USA", "ethan fang": "USA",
  "matt fitzpatrick": "ENG", "tommy fleetwood": "ENG", "ryan fox": "NZL",
  "sergio garcia": "ESP", "ryan gerard": "USA", "chris gotterup": "USA",
  "max greyserman": "USA", "ben griffin": "USA", "harry hall": "ENG",
  "brian harman": "USA", "tyrrell hatton": "ENG", "russell henley": "USA",
  "jackson herrington": "USA", "nicolai hjgaard": "DEN", "rasmus hjgaard": "DEN",
  "brandon holtz": "USA", "max homa": "USA", "viktor hovland": "NOR",
  "mason howell": "USA", "sungjae im": "KOR", "casey jarvis": "RSA",
  "dustin johnson": "USA", "zach johnson": "USA", "naoyuki kataoka": "JPN",
  "john keefer": "USA", "michael kim": "USA", "si woo kim": "KOR",
  "kurt kitayama": "USA", "jake knapp": "USA", "brooks koepka": "USA",
  "fifa laopakdee": "THA", "min woo lee": "AUS", "haotong li": "CHN",
  "shane lowry": "IRL", "robert macintyre": "SCO", "hideki matsuyama": "JPN",
  "matt mccarty": "USA", "rory mcilroy": "NIR", "tom mckibbin": "NIR",
  "maverick mcnealy": "USA", "collin morikawa": "USA",
  "rasmus neergaardpetersen": "DEN", "alex noren": "SWE", "andrew novak": "USA",
  "jose maria olazabal": "ESP", "carlos ortiz": "MEX", "marco penge": "ENG",
  "aldrich potgieter": "RSA", "mateo pulcini": "ARG", "jon rahm": "ESP",
  "aaron rai": "ENG", "patrick reed": "USA", "kristoffer reitan": "NOR",
  "davis riley": "USA", "justin rose": "ENG", "xander schauffele": "USA",
  "scottie scheffler": "USA", "charl schwartzel": "RSA", "adam scott": "AUS",
  "vijay singh": "FIJ", "cameron smith": "AUS", "jj spaun": "USA",
  "jordan spieth": "USA", "samuel stevens": "USA", "sepp straka": "AUT",
  "nick taylor": "CAN", "justin thomas": "USA", "sami valimaki": "FIN",
  "bubba watson": "USA", "mike weir": "CAN", "danny willett": "ENG",
  "gary woodland": "USA", "cameron young": "USA",
};

function normalizeName(name) {
  return (name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z ]/g, '').trim();
}

function getCountryFlag(playerName) {
  // Try as-is first (e.g. "Scottie Scheffler")
  let code = MASTERS_2026_COUNTRIES[normalizeName(playerName)];
  if (!code && playerName.includes(',')) {
    // Data Golf uses "Last, First" — flip to "First Last"
    const parts = playerName.split(',').map(s => s.trim());
    if (parts.length === 2) {
      code = MASTERS_2026_COUNTRIES[normalizeName(parts[1] + ' ' + parts[0])];
    }
  }
  if (!code) return '';
  return countryToFlag(code);
}

// ─── Tee time lookup ────────────────────────────────────────────────────────
async function getTeeTimes(tournamentId) {
  if (!tournamentId) return new Map();

  // Figure out current round: the highest round_num that has tee times
  // where at least one tee time has passed (or is upcoming today)
  const { data: allTees } = await supabase
    .from('tee_times')
    .select('player_name, tee_time, round_num')
    .eq('tournament_id', tournamentId)
    .order('round_num', { ascending: false });

  if (!allTees || allTees.length === 0) return new Map();

  // Group by round to find the current/next round
  const rounds = {};
  for (const t of allTees) {
    if (!rounds[t.round_num]) rounds[t.round_num] = [];
    rounds[t.round_num].push(t);
  }

  // Current round = highest round with tee times
  const currentRound = Math.max(...Object.keys(rounds).map(Number));
  const teeMap = new Map();

  for (const t of rounds[currentRound] || []) {
    const key = normalizeName(t.player_name);
    teeMap.set(key, t.tee_time);
    // Also store by exact name
    teeMap.set(t.player_name, t.tee_time);
  }

  return teeMap;
}

function formatTeeTime(isoString) {
  try {
    const d = new Date(isoString);
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m}`;
  } catch {
    return null;
  }
}

// ─── Main enrichment function ───────────────────────────────────────────────
// Call this on the standings response before sending to client.
// Modifies player objects in-place.
async function enrichStandings(standingsData) {
  if (!standingsData || !standingsData.standings) return standingsData;

  const tournamentId = standingsData.tournament?.id;
  const teeMap = await getTeeTimes(tournamentId);

  // Collect all players for position cache update
  const allPlayers = [];

  for (const team of standingsData.standings) {
    for (const player of team.players || []) {
      const rawName = player.playerName; // save before any modification
      allPlayers.push({ rawName, player });

      // 1. Tee time in thru field when player hasn't started (before name changes)
      const notStarted = !player.thru || player.thru === '-' || player.thru === '0';
      if (notStarted) {
        const tee = teeMap.get(rawName) || teeMap.get(normalizeName(rawName));
        if (tee) {
          const formatted = formatTeeTime(tee);
          if (formatted) {
            player.thru = formatted;
            if (!player.position || player.position === '-') {
              player.position = '--';
            }
          }
        }
      }

      // 2. Position movement arrows (before name changes)
      const arrow = getMovementArrow(rawName, player.position);
      if (arrow && player.position && player.position !== '-' && player.position !== '--') {
        player.position = arrow + player.position;
      }

      // 3. Country flag on player name (last — so other lookups use raw name)
      player.rawPlayerName = rawName;
      const flag = getCountryFlag(rawName);
      if (flag) {
        player.playerName = flag + ' ' + player.playerName;
      }
    }
  }

  // Update position cache for next request (using raw names)
  updatePositionCache(allPlayers.map(({ rawName, player }) => ({
    playerName: rawName,
    position: player.position,
  })));

  return standingsData;
}

// Same enrichment for the leaderboard endpoint
async function enrichLeaderboard(leaderboardData) {
  if (!leaderboardData || !leaderboardData.leaderboard) return leaderboardData;

  const tournamentId = leaderboardData.tournament?.id;
  const teeMap = await getTeeTimes(tournamentId);

  const cacheEntries = [];

  for (const player of leaderboardData.leaderboard) {
    const rawName = player.playerName;

    // 1. Tee time
    const notStarted = !player.thru || player.thru === '-' || player.thru === '0';
    if (notStarted) {
      const tee = teeMap.get(rawName) || teeMap.get(normalizeName(rawName));
      if (tee) {
        const formatted = formatTeeTime(tee);
        if (formatted) {
          player.thru = formatted;
          if (!player.position || player.position === '-') {
            player.position = '--';
          }
        }
      }
    }

    // 2. Movement arrows
    const arrow = getMovementArrow(rawName, player.position);
    if (arrow && player.position && player.position !== '-' && player.position !== '--') {
      player.position = arrow + player.position;
    }

    // 3. Country flag (last)
    player.rawPlayerName = rawName;
    const flag = getCountryFlag(rawName);
    if (flag) {
      player.playerName = flag + ' ' + player.playerName;
    }

    cacheEntries.push({ playerName: rawName, position: player.position });
  }

  updatePositionCache(cacheEntries);

  return leaderboardData;
}

module.exports = { enrichStandings, enrichLeaderboard };
