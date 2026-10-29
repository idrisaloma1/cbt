const router = require('express').Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { teacherAuth, JWT_SECRET } = require('../middleware/auth');

// ─── TEACHER LOGIN ────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const { rows } = db.query(
      `SELECT t.*, c.name as class_name FROM teachers t
       LEFT JOIN classes c ON c.id=t.class_id
       WHERE t.username=$1`, [username.trim()]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid username or password' });

    const teacher = rows[0];
    const valid = await bcrypt.compare(password, teacher.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign(
      { id: teacher.id, name: teacher.name, username: teacher.username, classId: teacher.class_id },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      teacher: { id: teacher.id, name: teacher.name, username: teacher.username, classId: teacher.class_id, className: teacher.class_name }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET CURRENT TEACHER ──────────────────────────────────
router.get('/me', teacherAuth, (req, res) => {
  res.json({ teacher: req.teacher });
});

// ══════════════════════════════════════════
//  ADMIN: MANAGE TEACHER ACCOUNTS
//  (No auth gate here — same trust model as the rest of the
//   admin dashboard in this offline single-PC app)
// ══════════════════════════════════════════

router.get('/admin/teachers', (req, res) => {
  try {
    const { rows } = db.query(
      `SELECT t.id, t.name, t.username, t.created_at, t.class_id, c.name as class_name,
        (SELECT COUNT(*) FROM exams WHERE teacher_id=t.id) as exam_count
       FROM teachers t
       LEFT JOIN classes c ON c.id=t.class_id
       ORDER BY t.name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/teachers', async (req, res) => {
  try {
    const { name, username, password, classId } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username and password required' });
    if (!classId) return res.status(400).json({ error: 'Please assign a class to this teacher' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = db.query(
      'INSERT INTO teachers (name, username, password_hash, class_id) VALUES ($1,$2,$3,$4) RETURNING id,name,username,class_id,created_at',
      [name.trim(), username.trim(), hash, classId]
    );
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/teachers/:id/class', (req, res) => {
  try {
    const { classId } = req.body;
    if (!classId) return res.status(400).json({ error: 'Class required' });
    db.query('UPDATE teachers SET class_id=$1 WHERE id=$2', [classId, req.params.id]);
    res.json({ message: 'Class assignment updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/admin/teachers/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const hash = await bcrypt.hash(password, 10);
    db.query('UPDATE teachers SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ message: 'Password reset successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/teachers/:id', (req, res) => {
  try {
    // Exams created by this teacher are kept but unassigned, not deleted —
    // losing exam data because an account was removed would be worse.
    db.query('UPDATE exams SET teacher_id=NULL WHERE teacher_id=$1', [req.params.id]);
    db.query('DELETE FROM teachers WHERE id=$1', [req.params.id]);
    res.json({ message: 'Teacher account removed. Their exams are now unassigned, not deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN TOKEN ─────────────────────────────────────────
// Gives the admin panel a short-lived JWT so it can call
// /api/cbt routes (create exams, manage questions, etc.)
// No password — this is a local offline app; the admin panel
// is only reachable on this PC at localhost.
router.get('/admin-token', (req, res) => {
  try {
    const token = jwt.sign(
      { id: 0, name: 'Admin', username: 'admin', classId: null, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
