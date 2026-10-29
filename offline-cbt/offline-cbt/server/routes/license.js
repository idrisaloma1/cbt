const router = require('express').Router();
const db = require('../db');
const { isValidKey } = require('../license-keys');

const TRIAL_DAYS = 30;
const LICENSE_MONTHS = 12;

// Ensure trial_meta table exists
try {
  db.query(`CREATE TABLE IF NOT EXISTS trial_meta (
    id INTEGER PRIMARY KEY DEFAULT 1,
    started_at TEXT NOT NULL
  )`);
} catch(e) {}

function getOrStartTrial() {
  try {
    const { rows } = db.query('SELECT * FROM trial_meta WHERE id=1');
    if (rows[0]) return rows[0].started_at;
    const now = new Date().toISOString();
    db.query('INSERT INTO trial_meta (id, started_at) VALUES (1, $1)', [now]);
    return now;
  } catch(e) { return null; }
}

function getDaysRemaining(startedAt) {
  if (!startedAt) return TRIAL_DAYS;
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 86400000);
  return Math.max(0, TRIAL_DAYS - elapsed);
}

function getLicenseDaysRemaining(activatedAt) {
  if (!activatedAt) return 0;
  const expiry = new Date(activatedAt);
  expiry.setMonth(expiry.getMonth() + LICENSE_MONTHS);
  const remaining = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
  return Math.max(0, remaining);
}

function getLicenseExpiryDate(activatedAt) {
  const expiry = new Date(activatedAt);
  expiry.setMonth(expiry.getMonth() + LICENSE_MONTHS);
  return expiry.toISOString().split('T')[0];
}

// ─── CHECK ACTIVATION STATUS ──────────────────────────────
router.get('/status', (req, res) => {
  try {
    const { rows } = db.query('SELECT * FROM license WHERE id=1');
    if (rows[0]) {
      const daysRemaining = getLicenseDaysRemaining(rows[0].activated_at);
      const expiryDate = getLicenseExpiryDate(rows[0].activated_at);

      if (daysRemaining <= 0) {
        // License expired — treat as not activated
        return res.json({
          activated: false,
          expired: true,
          daysRemaining: 0,
          expiryDate,
          schoolName: rows[0].school_name
        });
      }

      return res.json({
        activated: true,
        schoolName: rows[0].school_name,
        activatedAt: rows[0].activated_at,
        expiryDate,
        daysRemaining,
        expiringSoon: daysRemaining <= 30
      });
    }

    // Not activated — check/start trial
    const startedAt = getOrStartTrial();
    const daysRemaining = getDaysRemaining(startedAt);

    if (daysRemaining > 0) {
      return res.json({ activated: false, trial: true, daysRemaining });
    } else {
      return res.json({ activated: false, trial: false, daysRemaining: 0 });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ACTIVATE / RENEW ─────────────────────────────────────
router.post('/activate', (req, res) => {
  try {
    const { key, schoolName } = req.body;
    if (!key) return res.status(400).json({ error: 'Please enter your activation key.' });

    if (!isValidKey(key)) {
      return res.status(401).json({ error: 'Invalid activation key. Please check the key and try again, or contact Infolab support.' });
    }

    const { rows: existing } = db.query('SELECT * FROM license WHERE id=1');

    if (existing[0]) {
      // Renewal — replace the old key and reset activated_at to now
      db.query(
        'UPDATE license SET activation_key=$1, activated_at=datetime(\'now\') WHERE id=1',
        [key.trim().toUpperCase()]
      );
      const expiryDate = getLicenseExpiryDate(new Date().toISOString());
      return res.json({
        message: `License renewed successfully! Valid until ${expiryDate}.`,
        renewed: true,
        expiryDate
      });
    }

    // Fresh activation
    db.query(
      'INSERT INTO license (id, activation_key, school_name) VALUES (1,$1,$2)',
      [key.trim().toUpperCase(), schoolName || null]
    );
    const expiryDate = getLicenseExpiryDate(new Date().toISOString());
    res.json({
      message: `Activated successfully! License valid until ${expiryDate}. Welcome to Infolab Offline CBT.`,
      expiryDate
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
