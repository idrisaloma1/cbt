// ── Offline CBT Database (SQLite) ──────────────────────────────────────
// Mirrors the EduTec SMS CBT schema, minus school_id (single-school, offline)

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store the DB file next to the app, in a writable user-data location.
// When packaged with Electron, __dirname points inside the app's resources,
// so we use a separate writable folder for the actual .db file.
const DB_DIR = process.env.CBT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'cbt.db');

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL'); // better concurrent read/write on a single file

// ── Schema ──────────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    adm_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    class_id INTEGER REFERENCES classes(id)
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    class_id INTEGER REFERENCES classes(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS license (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activation_key TEXT NOT NULL,
    school_name TEXT,
    activated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    teacher_id INTEGER REFERENCES teachers(id),
    subject_id INTEGER REFERENCES subjects(id),
    class_id INTEGER REFERENCES classes(id),
    session TEXT,
    term INTEGER DEFAULT 1,
    duration_minutes INTEGER DEFAULT 60,
    total_marks INTEGER DEFAULT 100,
    instructions TEXT,
    start_time TEXT,
    end_time TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id),
    question_no INTEGER,
    question_text TEXT NOT NULL,
    question_type TEXT DEFAULT 'objective',
    option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT,
    correct_answer TEXT,
    marks INTEGER DEFAULT 1,
    image_url TEXT
  );

  CREATE TABLE IF NOT EXISTS exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id),
    student_id INTEGER NOT NULL REFERENCES students(id),
    status TEXT DEFAULT 'in_progress',
    total_marks INTEGER,
    objective_score REAL DEFAULT 0,
    theory_score REAL DEFAULT 0,
    total_score REAL DEFAULT 0,
    percentage REAL DEFAULT 0,
    time_taken_minutes INTEGER,
    started_at TEXT DEFAULT (datetime('now')),
    submitted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS exam_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id),
    question_id INTEGER NOT NULL REFERENCES exam_questions(id),
    answer TEXT,
    is_correct INTEGER,
    marks_awarded REAL DEFAULT 0,
    teacher_comment TEXT,
    marked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_questions_exam ON exam_questions(exam_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_exam ON exam_attempts(exam_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_student ON exam_attempts(student_id);
  CREATE INDEX IF NOT EXISTS idx_answers_attempt ON exam_answers(attempt_id);
`);

// ── Migration: add teacher_id to exams if upgrading from an older database ──
// CREATE TABLE IF NOT EXISTS doesn't add new columns to an already-existing
// table, so existing installs need this explicit check.
const examColumns = sqlite.prepare("PRAGMA table_info(exams)").all().map(c => c.name);
if (!examColumns.includes('teacher_id')) {
  sqlite.exec('ALTER TABLE exams ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)');
  console.log('✅ Migrated: added teacher_id column to exams table');
}

const teacherColumns = sqlite.prepare("PRAGMA table_info(teachers)").all().map(c => c.name);
if (!teacherColumns.includes('class_id')) {
  sqlite.exec('ALTER TABLE teachers ADD COLUMN class_id INTEGER REFERENCES classes(id)');
  console.log('✅ Migrated: added class_id column to teachers table');
}

// ── Postgres-style query() wrapper ─────────────────────────────────────
// Lets route code stay close to the original ($1, $2... -> ?, ? translation)
// so porting from the Postgres version requires minimal logic changes.
//
// IMPORTANT: Postgres allows the same $N to appear multiple times in one
// query, referring to the same value each time. SQLite's positional `?`
// requires one value per occurrence. So we expand the SQL text's $N
// references into the correctly-ordered, correctly-repeated list of
// actual values before binding.
function expandParams(text, params) {
  const orderedValues = [];
  const sql = text.replace(/\$(\d+)/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1; // $1 -> params[0]
    orderedValues.push(params[idx]);
    return '?';
  });
  return { sql, values: orderedValues };
}

function query(text, params = []) {
  const { sql: expandedSql, values } = expandParams(text, params);
  const sql = expandedSql.trim();
  const isSelect = /^select/i.test(sql);

  if (isSelect) {
    const rows = sqlite.prepare(sql).all(...values);
    return { rows };
  }

  // INSERT / UPDATE / DELETE
  const hasReturning = /returning/i.test(sql);
  if (hasReturning) {
    // better-sqlite3 doesn't support RETURNING on older versions uniformly;
    // strip it, run the statement, then fetch the row by lastInsertRowid or match.
    const cleanSql = sql.replace(/returning\s+.*/i, '').trim();
    // values were already expanded against the FULL sql (including RETURNING *,
    // which has no $N references), so they still line up correctly with cleanSql.
    const stmt = sqlite.prepare(cleanSql);
    const info = stmt.run(...values);

    if (/^insert/i.test(cleanSql)) {
      const table = cleanSql.match(/insert into (\w+)/i)[1];
      const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
      return { rows: row ? [row] : [] };
    }
    if (/^update/i.test(cleanSql)) {
      const table = cleanSql.match(/update (\w+)/i)[1];
      // best-effort: re-select using the original WHERE clause (re-expanded
      // against the original $N params so repeated references work here too)
      const whereMatchOriginal = text.match(/where\s+(.*?)(?:\s+returning|\s*$)/i);
      if (whereMatchOriginal) {
        const { sql: whereSql, values: whereValues } = expandParams(whereMatchOriginal[1], params);
        const selectSql = `SELECT * FROM ${table} WHERE ${whereSql}`;
        const row = sqlite.prepare(selectSql).get(...whereValues);
        return { rows: row ? [row] : [] };
      }
    }
    return { rows: [] };
  }

  const info = sqlite.prepare(sql).run(...values);
  return { rows: [], rowCount: info.changes };
}

module.exports = { query, sqlite, DB_PATH };
