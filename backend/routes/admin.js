const express = require('express');
const router = express.Router();
const pool = require('../config/db');

const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, error: "Admin access denied" });
  }
  next();
}

router.use(requireAdmin);

// POST /admin/add-coins
router.post('/add-coins', async (req, res) => {
  const { userId, amount, coins } = req.body;

  // support both "amount" and "coins" from frontend
  const inc = Number(amount ?? coins);

  if (!userId || Number.isNaN(inc)) {
    return res.status(400).json({ success: false, error: 'Invalid userId or amount' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET coins = COALESCE(coins, 0) + $1
       WHERE id = $2
       RETURNING id, name, email, coins`,
      [inc, userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/auto-resolve", requireAdmin, async (req, res) => {
  try {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: "ODDS_API_KEY missing" });

    const sportKey = "soccer_england_efl_cup";
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores`;

    const r = await axios.get(url, {
      params: { apiKey, daysFrom: 3, dateFormat: "iso" },
      timeout: 10000,
    });

    const events = r.data || [];

    // completed if scores exist and completed flag is true (depends on API shape)
    const completed = events.filter(e => e.completed === true);

    let resolved = 0;

    for (const ev of completed) {
      const externalId = `odds_${ev.id}`;

      // Find this game in DB
      const gameRes = await pool.query("SELECT * FROM games WHERE external_id = $1", [externalId]);
      if (gameRes.rows.length === 0) continue;

      const game = gameRes.rows[0];

      // Determine winner from scores (you’ll paste one sample response if shape differs)
      // Common shape: ev.scores = [{name, score}, {name, score}]
      const scores = ev.scores || [];
      const s1 = scores.find(s => s.name === game.team1_name);
      const s2 = scores.find(s => s.name === game.team2_name);
      if (!s1 || !s2) continue;

      const team1Score = Number(s1.score);
      const team2Score = Number(s2.score);
      if (Number.isNaN(team1Score) || Number.isNaN(team2Score)) continue;

      let outcome = "lost";
      let winningTeam = null;

      if (team1Score > team2Score) winningTeam = game.team1_name;
      else if (team2Score > team1Score) winningTeam = game.team2_name;
      else winningTeam = "Draw";

      // Resolve all pending bets for this game_name (your bets store game_name, not game_id)
      const betsRes = await pool.query(
        "SELECT * FROM bets WHERE status = 'pending' AND game_name = $1",
        [game.game_name]
      );

      for (const bet of betsRes.rows) {
        const won = bet.selected_team === winningTeam;
        const newStatus = won ? "won" : "lost";

        await pool.query("UPDATE bets SET status = $1 WHERE id = $2", [newStatus, bet.id]);

        if (won) {
          const winnings = Number(bet.bet_amount) * Number(bet.odds);
          await pool.query(
            "UPDATE users SET coins = COALESCE(coins,0) + $1 WHERE id = $2",
            [winnings, bet.user_id]
          );
        }
        resolved++;
      }
    }
    req.app.get("io")?.emit("betsUpdated");
    req.app.get("io")?.emit("balanceUpdated");

    return res.json({ success: true, resolved, completedEvents: completed.length });
  } catch (err) {
    console.error(err?.response?.data || err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/resolve-bet
router.post('/resolve-bet', async (req, res) => {
  const { betId, result } = req.body; // result = 'won' or 'lost'
  if (!betId || (result !== 'won' && result !== 'lost')) {
    return res.status(400).json({ success: false, error: "result must be 'won' or 'lost'" });
  }  
  try {
    // 1️⃣ Get the bet
    const betResult = await pool.query('SELECT * FROM bets WHERE id = $1', [betId]);
    if (betResult.rows.length === 0) return res.status(400).json({ success: false, error: 'Bet not found' });

    const bet = betResult.rows[0];

    // 2️⃣ If won, add coins
    if (result === 'won') {
      const winnings = bet.bet_amount * bet.odds;
      await pool.query(
        'UPDATE users SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
        [winnings, bet.user_id]
      );      
    }

    // 3️⃣ Update bet status
    const update = await pool.query('UPDATE bets SET status = $1 WHERE id = $2 RETURNING *', [result, betId]);

    res.json({ success: true, bet: update.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// POST /admin/add-game
router.post('/add-game', async (req, res) => {
  const { gameName, gameType, odds, startTime } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO games (game_name, game_type, odds, start_time) VALUES ($1,$2,$3,$4) RETURNING *',
      [gameName, gameType, odds, startTime]
    );

    res.json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
