const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../config/db');

// POST /register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // insert into database
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// POST /login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
  
    try {
      // find user by email
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );
  
      if (result.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'User not found' });
      }
  
      const user = result.rows[0];
  
      // compare password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(400).json({ success: false, error: 'Invalid password' });
      }
  
      // login success
      res.json({
        success: true,
        user: { id: user.id, name: user.name, email: user.email }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
module.exports = router;
