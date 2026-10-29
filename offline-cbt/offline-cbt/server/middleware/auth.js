const jwt = require('jsonwebtoken');
const db = require('../db');

// Offline app — this secret never needs to be "secure against the internet",
// it only needs to stop one teacher from forging another teacher's token on
// the same shared PC. A fixed local secret is fine for this threat model.
const JWT_SECRET = 'infolab-offline-cbt-local-secret-2026';

function teacherAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please log in to continue.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.teacher = decoded; // { id, name, username }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Blocks every /api/cbt and /api/teachers route until the app has been
// activated with a valid key — UNLESS the 30-day free trial is still
// running, in which case it lets requests through normally.
const TRIAL_DAYS = 30;

function getTrialDaysRemaining() {
  try {
    const { rows } = db.query('SELECT * FROM trial_meta WHERE id=1');
    const startedAt = rows[0] ? rows[0].started_at : null;
    if (!startedAt) return TRIAL_DAYS;
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 86400000);
    return Math.max(0, TRIAL_DAYS - elapsed);
  } catch (e) {
    return TRIAL_DAYS;
  }
}

function requireActivation(req, res, next) {
  try {
    const { rows } = db.query('SELECT * FROM license WHERE id=1');
    if (rows[0]) {
      // Check yearly license hasn't expired
      const activatedAt = rows[0].activated_at;
      if (activatedAt) {
        const expiry = new Date(activatedAt);
        expiry.setMonth(expiry.getMonth() + 12);
        if (Date.now() > expiry.getTime()) {
          return res.status(403).json({
            error: 'Your annual license has expired. Please renew by entering a new activation key.',
            notActivated: true,
            expired: true
          });
        }
      }
      return next(); // valid, not expired
    }

    // Not activated yet — allow through as long as the trial hasn't expired
    if (getTrialDaysRemaining() > 0) return next();

    return res.status(403).json({ error: 'Your 30-day free trial has expired. Please enter your activation key to continue.', notActivated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { teacherAuth, requireActivation, JWT_SECRET };
