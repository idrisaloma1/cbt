// Backup / restore for the single-file SQLite database.
// All routes are restricted to the Admin PC itself (loopback) so nobody on the
// school network can download or overwrite the data.
const router = require('express').Router();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { sqlite, DB_PATH } = require('../db');

const DB_DIR = path.dirname(DB_PATH);
const CONFIG_PATH = path.join(DB_DIR, 'backup-config.json');
const PENDING_PATH = path.join(DB_DIR, 'cbt.restore.db');
const NAME_RE = /^CBT-Backup-.*\.db$/;

function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
  res.status(403).json({ error: 'Backup and restore can only be done on the Admin computer itself.' });
}
router.use(localOnly);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function makeBackup(destFile) {
  await sqlite.backup(destFile); // consistent snapshot, safe while the app is in use
  return destFile;
}

function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter(f => NAME_RE.test(f)).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, modified: st.mtime.toISOString() };
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  } catch (e) { return []; }
}

function prune(dir, keep) {
  listBackups(dir).slice(keep).forEach(b => { try { fs.unlinkSync(path.join(dir, b.name)); } catch (e) {} });
}

async function runConfiguredBackup() {
  const cfg = readConfig();
  if (!cfg.dir) throw new Error('No backup folder has been set yet.');
  fs.mkdirSync(cfg.dir, { recursive: true });
  const file = path.join(cfg.dir, `CBT-Backup-${stamp()}.db`);
  await makeBackup(file);
  prune(cfg.dir, cfg.keep || 14);
  cfg.lastBackup = new Date().toISOString();
  cfg.lastError = null;
  writeConfig(cfg);
  return path.basename(file);
}

// Validate a candidate database file, then stage it; the swap happens at next start-up.
function stageRestore(srcFile) {
  let test;
  try {
    test = new Database(srcFile, { readonly: true, fileMustExist: true });
    const tables = test.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['classes', 'students', 'exams', 'exam_attempts']) {
      if (!tables.includes(t)) throw new Error('This file is not an Infolab CBT backup.');
    }
    const ok = test.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('The backup file is damaged.');
  } catch (e) {
    if (/not a database/i.test(e.message)) throw new Error('This file is not an Infolab CBT backup.');
    throw e;
  } finally { if (test) test.close(); }
  fs.copyFileSync(srcFile, PENDING_PATH);
}

function scheduleExit() {
  setTimeout(() => process.exit(0), 1500); // app closes; reopening applies the restore
}

router.get('/status', (req, res) => {
  const cfg = readConfig();
  res.json({ dir: cfg.dir || '', keep: cfg.keep || 14, lastBackup: cfg.lastBackup || null,
    lastError: cfg.lastError || null, backups: cfg.dir ? listBackups(cfg.dir) : [], dbPath: DB_PATH });
});

router.post('/config', express.json(), (req, res) => {
  try {
    const dir = (req.body.dir || '').trim();
    const cfg = readConfig();
    if (!dir) { delete cfg.dir; writeConfig(cfg); return res.json({ message: 'Automatic backup turned off.' }); }
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    cfg.dir = dir; writeConfig(cfg);
    res.json({ message: 'Backup folder saved. A backup will now run automatically every day.' });
  } catch (e) { res.status(400).json({ error: 'Cannot use that folder: ' + e.message }); }
});

router.post('/now', async (req, res) => {
  try { res.json({ message: 'Backup saved: ' + await runConfiguredBackup() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/download', async (req, res) => {
  const tmp = path.join(os.tmpdir(), `CBT-Backup-${stamp()}.db`);
  try {
    await makeBackup(tmp);
    res.download(tmp, path.basename(tmp), () => { try { fs.unlinkSync(tmp); } catch (e) {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/restore-upload', express.raw({ type: '*/*', limit: '1gb' }), (req, res) => {
  const tmp = path.join(os.tmpdir(), 'cbt-upload-' + Date.now() + '.db');
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file received.' });
    fs.writeFileSync(tmp, req.body);
    stageRestore(tmp);
    res.json({ message: 'Backup accepted. The app will now close — open it again to finish restoring.' });
    scheduleExit();
  } catch (e) { res.status(400).json({ error: e.message }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
});

router.post('/restore-saved', express.json(), (req, res) => {
  try {
    const cfg = readConfig();
    const name = path.basename(req.body.name || '');
    if (!cfg.dir || !NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid backup.' });
    stageRestore(path.join(cfg.dir, name));
    res.json({ message: 'Backup accepted. The app will now close — open it again to finish restoring.' });
    scheduleExit();
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Daily automatic backup: check on start-up and every hour.
function startScheduler() {
  const tick = async () => {
    const cfg = readConfig();
    if (!cfg.dir) return;
    const last = cfg.lastBackup ? new Date(cfg.lastBackup).getTime() : 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    try { await runConfiguredBackup(); }
    catch (e) { const c = readConfig(); c.lastError = e.message; writeConfig(c); }
  };
  setTimeout(tick, 15000);
  setInterval(tick, 3600 * 1000);
}

module.exports = router;
module.exports.startScheduler = startScheduler;
