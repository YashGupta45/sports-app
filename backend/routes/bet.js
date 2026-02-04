const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const axios = require("axios");

// Debug ping
router.get("/ping", (req, res) => res.json({ success: true, msg: "bet routes loaded" }));

/**
 * Odds API config (EFL Cup only for now)
 */
const SPORT_KEY = "soccer_england_efl_cup";
const ODDS_PARAMS = {
  regions: "uk",
  markets: "h2h",
  oddsFormat: "decimal",
  dateFormat: "iso",
};

// Cooldown to avoid burning credits
let lastOddsSyncAt = 0;
const ODDS_SYNC_COOLDOWN_MS = 15 * 30 * 1000; // 30 seconds

/**
 * Sync Odds API -> Upsert current matches -> Delete finished matches
 * Finished = not present in latest Odds API response for this sport
 */
async function syncEflCupOddsToDB() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY missing in .env");

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT_KEY}/odds`;

  const r = await axios.get(url, {
    params: { apiKey, ...ODDS_PARAMS },
    timeout: 10000,
  });

  const events = r.data || [];

  let upserted = 0;
  let skippedNoOdds = 0;

  // Track all matches returned NOW by Odds API
  const activeExternalIds = [];

  for (const ev of events) {
    const home = ev.home_team;
    const away = ev.away_team;

    // Best available odds across bookmakers
    let bestHome = null;
    let bestDraw = null;
    let bestAway = null;

    for (const bm of ev.bookmakers || []) {
      const h2h = (bm.markets || []).find((m) => m.key === "h2h");
      if (!h2h) continue;

      for (const out of h2h.outcomes || []) {
        if (out.name === home) bestHome = bestHome == null ? out.price : Math.max(bestHome, out.price);
        else if (out.name === away) bestAway = bestAway == null ? out.price : Math.max(bestAway, out.price);
        else if ((out.name || "").toLowerCase() === "draw")
          bestDraw = bestDraw == null ? out.price : Math.max(bestDraw, out.price);
      }
    }

    // Need at least home + away odds
    if (!bestHome || !bestAway) {
      skippedNoOdds++;
      continue;
    }

    const externalId = `odds_${ev.id}`; // avoid collisions
    activeExternalIds.push(externalId);

    const gameName = `${home} vs ${away} (EFL Cup)`;
    const gameType = "soccer";
    const startTime = ev.commence_time || null;

    await pool.query(
      `
      INSERT INTO games
        (external_id, game_name, game_type, odds, start_time, team1_name, team2_name,
         team1_odds, team2_odds, draw_odds, has_draw)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (external_id) DO UPDATE SET
        game_name = EXCLUDED.game_name,
        game_type = EXCLUDED.game_type,
        odds = EXCLUDED.odds,
        start_time = EXCLUDED.start_time,
        team1_name = EXCLUDED.team1_name,
        team2_name = EXCLUDED.team2_name,
        team1_odds = EXCLUDED.team1_odds,
        team2_odds = EXCLUDED.team2_odds,
        draw_odds = EXCLUDED.draw_odds,
        has_draw = EXCLUDED.has_draw
      `,
      [
        externalId,
        gameName,
        gameType,
        bestHome, // keep NOT NULL odds column happy
        startTime,
        home,
        away,
        bestHome,
        bestAway,
        bestDraw,
        !!bestDraw,
      ]
    );

    upserted++;
  }

  // Delete finished matches (not in current Odds API response)
  // Safety: only delete soccer games that came from Odds API (external_id starts with odds_)
  if (activeExternalIds.length > 0) {
    const placeholders = activeExternalIds.map((_, i) => `$${i + 1}`).join(",");

    await pool.query(
      `
      DELETE FROM games
      WHERE game_type = 'soccer'
        AND external_id LIKE 'odds_%'
        AND external_id NOT IN (${placeholders})
      `,
      activeExternalIds
    );
  } else {
    // If API returns 0 events, DO NOT delete everything (could be temporary API issue)
    // So we do nothing here.
  }

  return { fetched: events.length, upserted, skippedNoOdds, activeNow: activeExternalIds.length };
}

// -------------------------
// GET /api/bet/games
// Auto sync (cooldown) -> return DB games
// -------------------------
router.get("/games", async (req, res) => {
  let oddsSync = { ok: true, skipped: true };

  try {
    if (Date.now() - lastOddsSyncAt > ODDS_SYNC_COOLDOWN_MS) {
      const result = await syncEflCupOddsToDB();
      lastOddsSyncAt = Date.now();
      oddsSync = { ok: true, ...result, skipped: false };
      req.app.get("io")?.emit("gamesUpdated");
    }
  } catch (e) {
    oddsSync = { ok: false, error: e.message };
  }

  try {
    const db = await pool.query(
      "SELECT * FROM games WHERE external_id LIKE 'odds_%' ORDER BY start_time ASC NULLS LAST"
    );    
    return res.json({ success: true, oddsSync, games: db.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// -------------------------
// POST /api/bet/place (supports Draw)
// -------------------------
router.post("/place", async (req, res) => {
  const { userId, gameId, betAmount, selectedTeam } = req.body;
  const amount = Number(betAmount);

  if (!userId || !gameId || !selectedTeam || Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid userId, gameId, selectedTeam or betAmount" });
  }

  try {
    // 1) Get game
    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [gameId]);
    if (gameRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: "Game not found" });
    }
    const game = gameRes.rows[0];

    // 2) Choose odds
    let chosenOdds = null;

    if (selectedTeam === game.team1_name) chosenOdds = Number(game.team1_odds);
    else if (selectedTeam === game.team2_name) chosenOdds = Number(game.team2_odds);
    else if (selectedTeam === "Draw") {
      if (game.has_draw && game.draw_odds) chosenOdds = Number(game.draw_odds);
    }

    if (!chosenOdds || Number.isNaN(chosenOdds)) {
      return res.status(400).json({ success: false, error: "Invalid selected team / odds not available" });
    }

    // 3) Check balance
    const userRes = await pool.query("SELECT coins FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: "User not found" });
    }

    const coins = Number(userRes.rows[0].coins || 0);
    if (coins < amount) {
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    }

    // 4) Deduct coins
    await pool.query("UPDATE users SET coins = COALESCE(coins,0) - $1 WHERE id = $2", [amount, userId]);

    // 5) Insert bet
    const betInsert = await pool.query(
      `
      INSERT INTO bets (user_id, game_name, game_type, bet_amount, odds, status, selected_team)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
      RETURNING *
      `,
      [userId, game.game_name, game.game_type, amount, chosenOdds, selectedTeam]
    );
    req.app.get("io")?.emit("betsUpdated", { userId });
    req.app.get("io")?.emit("balanceUpdated", { userId });
    
    return res.json({ success: true, bet: betInsert.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------
// GET /api/bet/user/:id/balance
// -------------------------
router.get("/user/:id/balance", async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await pool.query("SELECT id, name, email, coins FROM users WHERE id = $1", [userId]);
    if (result.rows.length === 0) return res.status(400).json({ success: false, error: "User not found" });
    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------
// GET /api/bet/user/:id/bets
// -------------------------
router.get("/user/:id/bets", async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await pool.query("SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return res.json({ success: true, bets: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
