const router = require('express').Router();
const db = require('../db');
const multer = require('multer');
const mammoth = require('mammoth');
const { teacherAuth } = require('../middleware/auth');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════════
//  QUESTION SHUFFLE HELPERS
//  Deterministic per-attempt shuffle: each student gets a
//  randomized question order, but it stays the SAME order
//  every time that attempt is loaded/resumed (no reshuffling
//  mid-exam on refresh, which would confuse students).
// ══════════════════════════════════════════

function hashStringToSeed(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a NEW array — original order is never mutated,
// so question_no / correct_answer bookkeeping stays intact.
function seededShuffle(array, seed) {
  const rng = mulberry32(hashStringToSeed(String(seed)));
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ══════════════════════════════════════════
//  SETUP ROUTES (classes, subjects, students)
//  Minimal — enough to run exams offline
// ══════════════════════════════════════════

router.get('/setup/classes', (req, res) => {
  try {
    const { rows } = db.query('SELECT * FROM classes ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/setup/classes', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Class name required' });
    const { rows } = db.query('INSERT INTO classes (name) VALUES ($1) RETURNING *', [name.trim()]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/setup/classes/:id', (req, res) => {
  try {
    const classId = req.params.id;

    const { rows: cls } = db.query('SELECT * FROM classes WHERE id=$1', [classId]);
    if (!cls[0]) return res.status(404).json({ error: 'Class not found' });

    const { rows: studentCount } = db.query('SELECT COUNT(*) as cnt FROM students WHERE class_id=$1', [classId]);
    const { rows: examCount } = db.query('SELECT COUNT(*) as cnt FROM exams WHERE class_id=$1', [classId]);
    const { rows: teacherCount } = db.query('SELECT COUNT(*) as cnt FROM teachers WHERE class_id=$1', [classId]);

    const students = parseInt(studentCount[0].cnt);
    const exams = parseInt(examCount[0].cnt);
    const teachers = parseInt(teacherCount[0].cnt);

    if (students > 0 || exams > 0) {
      const reasons = [];
      if (students > 0) reasons.push(`${students} student(s)`);
      if (exams > 0) reasons.push(`${exams} exam(s)`);
      return res.status(400).json({
        error: `Cannot delete "${cls[0].name}" — it still has ${reasons.join(' and ')} attached. Remove or reassign these first.`,
        students, exams, teachers
      });
    }

    // No students or exams. A teacher assignment alone doesn't block deletion —
    // just unassign the teacher's class rather than refuse the whole operation.
    if (teachers > 0) {
      db.query('UPDATE teachers SET class_id=NULL WHERE class_id=$1', [classId]);
    }

    db.query('DELETE FROM classes WHERE id=$1', [classId]);
    res.json({ message: `"${cls[0].name}" deleted successfully` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/setup/subjects', (req, res) => {
  try {
    const { rows } = db.query('SELECT * FROM subjects ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/setup/subjects', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Subject name required' });
    const { rows } = db.query('INSERT INTO subjects (name) VALUES ($1) RETURNING *', [name.trim()]);
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A subject with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/setup/subjects/:id', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Subject name required' });

    const { rows: existing } = db.query('SELECT * FROM subjects WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Subject not found' });

    db.query('UPDATE subjects SET name=$1 WHERE id=$2', [name.trim(), req.params.id]);
    res.json({ message: 'Subject updated' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'A subject with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/setup/subjects/:id', (req, res) => {
  try {
    const subjectId = req.params.id;

    const { rows: subj } = db.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subj[0]) return res.status(404).json({ error: 'Subject not found' });

    const { rows: examCount } = db.query('SELECT COUNT(*) as cnt FROM exams WHERE subject_id=$1', [subjectId]);
    const exams = parseInt(examCount[0].cnt);

    if (exams > 0) {
      return res.status(400).json({
        error: `Cannot delete "${subj[0].name}" — it still has ${exams} exam(s) attached. Remove or reassign those exams first.`,
        exams
      });
    }

    db.query('DELETE FROM subjects WHERE id=$1', [subjectId]);
    res.json({ message: `"${subj[0].name}" deleted successfully` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/setup/students', (req, res) => {
  try {
    const { classId } = req.query;
    let q = `SELECT s.*, c.name as class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id`;
    const params = [];
    if (classId) { q += ' WHERE s.class_id = $1'; params.push(classId); }
    q += ' ORDER BY s.name';
    const { rows } = db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/setup/students', (req, res) => {
  try {
    const { admNo, name, classId } = req.body;
    if (!admNo || !name) return res.status(400).json({ error: 'Admission number and name required' });
    const { rows } = db.query(
      'INSERT INTO students (adm_no, name, class_id) VALUES ($1,$2,$3) RETURNING *',
      [admNo.trim(), name.trim(), classId || null]
    );
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Admission number already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/setup/students/:id', (req, res) => {
  try {
    const { admNo, name, classId } = req.body;
    if (!admNo || !admNo.trim() || !name || !name.trim()) {
      return res.status(400).json({ error: 'Admission number and name required' });
    }

    const { rows: existing } = db.query('SELECT * FROM students WHERE id=$1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Student not found' });

    db.query(
      'UPDATE students SET adm_no=$1, name=$2, class_id=$3 WHERE id=$4',
      [admNo.trim(), name.trim(), classId || null, req.params.id]
    );
    res.json({ message: 'Student updated' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Admission number already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/setup/students/:id', (req, res) => {
  try {
    const studentId = req.params.id;

    const { rows: stu } = db.query('SELECT * FROM students WHERE id=$1', [studentId]);
    if (!stu[0]) return res.status(404).json({ error: 'Student not found' });

    const { rows: attemptCount } = db.query('SELECT COUNT(*) as cnt FROM exam_attempts WHERE student_id=$1', [studentId]);
    const attempts = parseInt(attemptCount[0].cnt);

    if (attempts > 0) {
      return res.status(400).json({
        error: `Cannot delete "${stu[0].name}" — they have ${attempts} exam attempt(s) on record. Removing them would break those results.`,
        attempts
      });
    }

    db.query('DELETE FROM students WHERE id=$1', [studentId]);
    res.json({ message: `"${stu[0].name}" deleted successfully` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROMOTE ALL STUDENTS ─────────────────────────────────
// Moves every student to the next class in the sorted class list.
// Students in the last class (e.g. SS3) are removed (graduated).
// The "next class" is determined by the ORDER of classes as stored —
// whatever order admin created them in, which matches the natural
// school progression (JSS1 → JSS2 → ... → SS3 → out).
router.post('/setup/students/promote-all', (req, res) => {
  try {
    // Get all classes — sort using natural order so Grade 2 comes before Grade 10
    const { rows: classList } = db.query('SELECT * FROM classes');
    if (classList.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 classes to promote students.' });
    }

    // Natural sort: handles "Grade 1", "Grade 2", ..., "Grade 10", "Grade 11" correctly
    classList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    // Build a map: classId → nextClassId (or null for the last class)
    const classOrder = classList.map(c => c.id);
    const nextClass = {};
    for (let i = 0; i < classOrder.length; i++) {
      nextClass[classOrder[i]] = i + 1 < classOrder.length ? classOrder[i + 1] : null;
    }

    // Get all students with a class assigned
    const { rows: students } = db.query('SELECT * FROM students WHERE class_id IS NOT NULL');

    let promoted = 0, graduated = 0, skipped = 0;

    for (const student of students) {
      const next = nextClass[student.class_id];
      if (next === undefined) {
        // Student is in an unrecognised class — skip
        skipped++;
        continue;
      }
      if (next === null) {
        // Last class — graduate (remove student)
        db.query('DELETE FROM students WHERE id=$1', [student.id]);
        graduated++;
      } else {
        // Move to next class
        db.query('UPDATE students SET class_id=$1 WHERE id=$2', [next, student.id]);
        promoted++;
      }
    }

    res.json({
      message: `Promotion complete! ${promoted} student${promoted===1?'':'s'} promoted, ${graduated} graduated (removed from last class).${skipped > 0 ? ` ${skipped} skipped (unknown class).` : ''}`,
      promoted,
      graduated,
      skipped
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/setup/students/bulk', (req, res) => {
  try {
    const { students } = req.body; // [{ admNo, name, classId }]
    let count = 0;
    const failed = [];
    for (const s of students) {
      try {
        db.query('INSERT INTO students (adm_no, name, class_id) VALUES ($1,$2,$3)', [s.admNo.trim(), s.name.trim(), s.classId || null]);
        count++;
      } catch (e) {
        failed.push({ admNo: s.admNo, name: s.name, reason: String(e.message).includes('UNIQUE') ? 'Admission number already exists' : e.message });
      }
    }
    res.json({
      message: failed.length
        ? `${count} student(s) added, ${failed.length} skipped (see details)`
        : `${count} students added`,
      count,
      failed
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
//  ADMIN / TEACHER ROUTES (exam management)
// ══════════════════════════════════════════

// Optional auth: if a teacher token is present, attach req.teacher.
// If absent, treat the request as admin (sees everything) — this lets
// admin.html keep working without a login while teacher.html requires one.
function optionalTeacherAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  teacherAuth(req, res, next);
}

router.get('/', optionalTeacherAuth, (req, res) => {
  try {
    const { session, term, classId } = req.query;
    let q = `SELECT e.*, s.name as subject_name, c.name as class_name, t.name as teacher_name,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id=e.id) as question_count,
      (SELECT COUNT(*) FROM exam_attempts WHERE exam_id=e.id AND status='submitted') as submissions
      FROM exams e
      LEFT JOIN subjects s ON s.id=e.subject_id
      LEFT JOIN classes c ON c.id=e.class_id
      LEFT JOIN teachers t ON t.id=e.teacher_id
      WHERE 1=1`;
    const params = [];
    if (req.teacher && !req.teacher.isAdmin) { params.push(req.teacher.id); q += ` AND e.teacher_id=$${params.length}`; }
    if (session) { params.push(session); q += ` AND e.session=$${params.length}`; }
    if (term) { params.push(parseInt(term)); q += ` AND e.term=$${params.length}`; }
    if (classId) { params.push(classId); q += ` AND e.class_id=$${params.length}`; }
    q += ' ORDER BY e.created_at DESC';
    const { rows } = db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', optionalTeacherAuth, (req, res) => {
  try {
    const { title, subjectId, classId: bodyClassId, session, term, durationMinutes, totalMarks, instructions, startTime, endTime } = req.body;
    if (!title) return res.status(400).json({ error: 'Exam title is required.' });

    let teacherId = null;
    let classId = bodyClassId || null;

    if (req.teacher && !req.teacher.isAdmin) {
      // Teacher: class is locked to their assigned class
      if (!req.teacher.classId) {
        return res.status(400).json({ error: 'Your account has no class assigned yet. Ask the admin to assign one before creating exams.' });
      }
      teacherId = req.teacher.id;
      classId = req.teacher.classId;
    }
    // Admin (isAdmin=true or no token): can pick any class from the request body

    const { rows } = db.query(
      `INSERT INTO exams (title,teacher_id,subject_id,class_id,session,term,duration_minutes,total_marks,instructions,start_time,end_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [title, teacherId, subjectId || null, classId, session, parseInt(term) || 1, parseInt(durationMinutes) || 60,
       parseInt(totalMarks) || 100, instructions || null, startTime || null, endTime || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared ownership check used by every route that acts on a specific exam.
// Admin (no token) can act on any exam; a teacher can only act on their own.
function checkExamOwnership(req, res, next) {
  const { rows } = db.query('SELECT teacher_id FROM exams WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Exam not found' });
  // Admin can manage any exam; teacher can only manage their own
  if (req.teacher && !req.teacher.isAdmin && rows[0].teacher_id !== req.teacher.id) {
    return res.status(403).json({ error: 'You do not have access to this exam.' });
  }
  next();
}

router.patch('/:id', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { title, subjectId, classId, durationMinutes, totalMarks, instructions, startTime, endTime, status } = req.body;
    db.query(
      `UPDATE exams SET title=$1,subject_id=$2,class_id=$3,duration_minutes=$4,total_marks=$5,
       instructions=$6,start_time=$7,end_time=$8,status=COALESCE($9,status) WHERE id=$10`,
      [title, subjectId || null, classId || null, parseInt(durationMinutes) || 60, parseInt(totalMarks) || 100,
       instructions || null, startTime || null, endTime || null, status || null, req.params.id]
    );
    const { rows } = db.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const examId = req.params.id;
    const { rows: qs } = db.query('SELECT id FROM exam_questions WHERE exam_id=$1', [examId]);
    for (const q of qs) db.query('DELETE FROM exam_answers WHERE question_id=$1', [q.id]);
    const { rows: attempts } = db.query('SELECT id FROM exam_attempts WHERE exam_id=$1', [examId]);
    for (const a of attempts) db.query('DELETE FROM exam_answers WHERE attempt_id=$1', [a.id]);
    db.query('DELETE FROM exam_attempts WHERE exam_id=$1', [examId]);
    db.query('DELETE FROM exam_questions WHERE exam_id=$1', [examId]);
    db.query('DELETE FROM exams WHERE id=$1', [examId]);
    res.json({ message: 'Exam deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/questions', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { rows } = db.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY question_no', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/questions', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { questionText, questionType, optionA, optionB, optionC, optionD, correctAnswer, marks, imageUrl } = req.body;
    const { rows: last } = db.query('SELECT MAX(question_no) as max FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    const nextNo = (last[0]?.max || 0) + 1;
    const { rows } = db.query(
      `INSERT INTO exam_questions (exam_id,question_no,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,marks,image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, nextNo, questionText, questionType || 'objective',
       optionA || null, optionB || null, optionC || null, optionD || null, correctAnswer || null, parseInt(marks) || 1, imageUrl || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/questions/bulk', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { questions } = req.body;
    db.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      db.query(
        `INSERT INTO exam_questions (exam_id,question_no,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,marks,image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.params.id, i + 1, q.questionText, q.questionType || 'objective',
         q.optionA || null, q.optionB || null, q.optionC || null, q.optionD || null, q.correctAnswer || null, parseInt(q.marks) || 1, q.imageUrl || null]
      );
    }
    res.json({ message: `${questions.length} questions saved` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parseQuestionsFromText(rawText) {
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ');

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const questions = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const qMatch = line.match(/^(\d+)[\.\)\:]\s*(.+)/);
    if (qMatch) {
      if (current) questions.push(current);
      let qText = qMatch[2].trim();
      qText = qText.replace(/ANSWER[:\s]+[A-Da-d]\s*$/i, '').trim();
      const isTheory = /\[THEORY\]|\(THEORY\)|\bTHEORY\b/i.test(qText);
      current = {
        questionText: qText.replace(/\[THEORY\]|\(THEORY\)|\bTHEORY\b/gi, '').trim(),
        questionType: isTheory ? 'theory' : 'objective',
        optionA: null, optionB: null, optionC: null, optionD: null,
        correctAnswer: null,
        marks: 1
      };
      continue;
    }

    if (!current) continue;

    const optMatch = line.match(/^[\(]?([A-Da-d])[\.\)\:]\s*(.+)/);
    if (optMatch && current.questionType === 'objective') {
      const letter = optMatch[1].toUpperCase();
      let val = optMatch[2].trim();
      const isCorrect = val.includes('*') || val.toLowerCase().includes('(correct)');
      const inlineAns = val.match(/ANSWER[:\s]+([A-Da-d])\s*$/i);
      if (inlineAns) {
        current.correctAnswer = inlineAns[1].toUpperCase();
        val = val.replace(/ANSWER[:\s]+[A-Da-d]\s*$/i, '').trim();
      }
      val = val.replace(/\*/g, '').replace(/\(correct\)/gi, '').trim();
      if (letter === 'A') current.optionA = val;
      if (letter === 'B') current.optionB = val;
      if (letter === 'C') current.optionC = val;
      if (letter === 'D') current.optionD = val;
      if (isCorrect) current.correctAnswer = letter;
      continue;
    }

    const ansMatch = line.match(/^(?:Answer|Ans|Correct|Key|ANSWER)[\.:\s]+([A-Da-d])/i);
    if (ansMatch && current) {
      current.correctAnswer = ansMatch[1].toUpperCase();
      continue;
    }

    const marksMatch = line.match(/^(?:Marks?|Mark|Score)[\.:\s]+(\d+)/i);
    if (marksMatch) {
      current.marks = parseInt(marksMatch[1]);
      continue;
    }

    if (/^(Instructions?|Section|Part|Note)/i.test(line)) continue;

    if (current && !optMatch && !ansMatch && !marksMatch) {
      if (!current.optionA) {
        current.questionText += ' ' + line;
      }
    }
  }
  if (current) questions.push(current);

  return questions;
}

router.post('/:id/upload-word', optionalTeacherAuth, checkExamOwnership, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    const questions = parseQuestionsFromText(result.value);

    const valid = questions.filter(q => {
      if (q.questionType === 'theory') return q.questionText && q.questionText.length > 2;
      return q.questionText && q.questionText.length > 2 && q.optionA && q.optionB;
    });

    if (valid.length === 0) return res.status(400).json({
      error: 'No valid questions found. Check the Word document format.',
      hint: 'Format: 1. Question text\nA. Option A\nB. Option B*\nC. Option C\nD. Option D\nAnswer: B'
    });

    db.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    for (let i = 0; i < valid.length; i++) {
      const q = valid[i];
      db.query(
        `INSERT INTO exam_questions (exam_id,question_no,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,marks,image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.params.id, i + 1, q.questionText, q.questionType,
         q.optionA, q.optionB, q.optionC, q.optionD, q.correctAnswer, q.marks, q.imageUrl || null]
      );
    }

    res.json({
      message: `${valid.length} questions imported successfully!`,
      questions: valid.length,
      objectives: valid.filter(q => q.questionType === 'objective').length,
      theory: valid.filter(q => q.questionType === 'theory').length
    });
  } catch (e) {
    console.error('Word upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/upload-text', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    if (!text.trim()) return res.status(400).json({ error: 'Nothing pasted.' });
    const questions = parseQuestionsFromText(text);
    const valid = questions.filter(q => q.questionType === 'theory'
      ? q.questionText && q.questionText.length > 2
      : q.questionText && q.questionText.length > 2 && q.optionA && q.optionB);
    if (!valid.length) return res.status(400).json({ error: 'No valid questions found in the pasted text.' });
    db.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    valid.forEach((q, i) => db.query(
      `INSERT INTO exam_questions (exam_id,question_no,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,marks,image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [req.params.id, i + 1, q.questionText, q.questionType, q.optionA, q.optionB, q.optionC, q.optionD, q.correctAnswer, q.marks, null]));
    res.json({ message: `${valid.length} questions imported successfully!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/questions/:qid', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { questionText, questionType, optionA, optionB, optionC, optionD, correctAnswer, marks, imageUrl } = req.body;
    db.query(
      `UPDATE exam_questions SET question_text=$1,question_type=$2,option_a=$3,option_b=$4,
       option_c=$5,option_d=$6,correct_answer=$7,marks=$8,image_url=$9 WHERE id=$10 AND exam_id=$11`,
      [questionText, questionType || 'objective', optionA || null, optionB || null,
       optionC || null, optionD || null, correctAnswer || null, parseInt(marks) || 1,
       imageUrl === undefined ? null : imageUrl, req.params.qid, req.params.id]
    );
    const { rows } = db.query('SELECT * FROM exam_questions WHERE id=$1', [req.params.qid]);
    if (!rows[0]) return res.status(404).json({ error: 'Question not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/questions/:qid', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    db.query('DELETE FROM exam_answers WHERE question_id=$1', [req.params.qid]);
    db.query('DELETE FROM exam_questions WHERE id=$1 AND exam_id=$2', [req.params.qid, req.params.id]);
    res.json({ message: 'Question deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/publish', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { rows: qs } = db.query('SELECT COUNT(*) as cnt FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    if (parseInt(qs[0].cnt) === 0) return res.status(400).json({ error: 'Add questions before publishing' });
    db.query("UPDATE exams SET status='published' WHERE id=$1", [req.params.id]);
    res.json({ message: 'Exam published! Students can now take it.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/close', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    db.query("UPDATE exams SET status='closed' WHERE id=$1", [req.params.id]);
    res.json({ message: 'Exam closed.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/results', optionalTeacherAuth, checkExamOwnership, (req, res) => {
  try {
    const { rows } = db.query(
      `SELECT ea.*, s.name as student_name, s.adm_no, c.name as class_name
       FROM exam_attempts ea
       JOIN students s ON s.id=ea.student_id
       LEFT JOIN classes c ON c.id=s.class_id
       WHERE ea.exam_id=$1 AND ea.status='submitted'
       ORDER BY ea.total_score DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COMBINED RESULTS ACROSS ALL EXAMS FOR ONE SUBJECT ────
// Teacher-only: every exam they've created for the given subject, with full
// score breakdown per student per exam, plus a running total/average.
router.get('/subject-results/:subjectId', teacherAuth, (req, res) => {
  try {
    const subjectId = req.params.subjectId;
    const isAdmin = req.teacher && req.teacher.isAdmin;

    let examQuery = `SELECT e.id, e.title, e.total_marks, e.created_at, e.teacher_id, e.class_id,
        t.name as teacher_name, c.name as class_name
       FROM exams e
       LEFT JOIN teachers t ON t.id=e.teacher_id
       LEFT JOIN classes c ON c.id=e.class_id
       WHERE e.subject_id=$1`;
    const params = [subjectId];
    if (!isAdmin) {
      params.push(req.teacher.id);
      examQuery += ` AND e.teacher_id=$${params.length}`;
    }
    examQuery += ' ORDER BY e.created_at ASC';

    const { rows: exams } = db.query(examQuery, params);

    if (exams.length === 0) {
      return res.json({ exams: [], blocks: [], summary: [] });
    }

    const blocks = exams.map(exam => {
      const { rows: results } = db.query(
        `SELECT ea.student_id, s.name as student_name, s.adm_no, ea.total_score, ea.percentage
         FROM exam_attempts ea
         JOIN students s ON s.id=ea.student_id
         WHERE ea.exam_id=$1 AND ea.status='submitted'
         ORDER BY ea.total_score DESC`,
        [exam.id]
      );
      return { exam, results };
    });

    // Build a per-student running total/average across every exam in this subject,
    // even if a student didn't sit every exam (their missing scores just don't count
    // toward their average, rather than being treated as zero).
    const studentTotals = {}; // student_id -> { name, adm_no, scores: [{examTitle, score, totalMarks}] }
    blocks.forEach(block => {
      block.results.forEach(r => {
        if (!studentTotals[r.student_id]) {
          studentTotals[r.student_id] = { studentId: r.student_id, name: r.student_name, admNo: r.adm_no, scores: [] };
        }
        studentTotals[r.student_id].scores.push({
          examTitle: block.exam.title,
          score: r.total_score,
          totalMarks: block.exam.total_marks
        });
      });
    });

    const summary = Object.values(studentTotals).map(st => {
      const totalScore = st.scores.reduce((sum, s) => sum + s.score, 0);
      const totalPossible = st.scores.reduce((sum, s) => sum + s.totalMarks, 0);
      const average = totalPossible > 0 ? (totalScore / st.scores.length).toFixed(1) : 0;
      return {
        studentId: st.studentId,
        name: st.name,
        admNo: st.admNo,
        examsTaken: st.scores.length,
        totalScore,
        totalPossible,
        averageScore: average
      };
    }).sort((a, b) => b.totalScore - a.totalScore);

    res.json({ exams, blocks, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ownership check for routes keyed by attempt or answer id, rather than exam id directly.
function checkAttemptOwnership(req, res, next) {
  const { rows } = db.query(
    `SELECT e.teacher_id FROM exam_attempts ea JOIN exams e ON e.id=ea.exam_id WHERE ea.id=$1`,
    [req.params.attemptId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Attempt not found' });
  if (req.teacher && rows[0].teacher_id !== req.teacher.id) {
    return res.status(403).json({ error: 'You do not have access to this submission.' });
  }
  next();
}

function checkAnswerOwnership(req, res, next) {
  const { rows } = db.query(
    `SELECT e.teacher_id FROM exam_answers ans
     JOIN exam_attempts ea ON ea.id=ans.attempt_id
     JOIN exams e ON e.id=ea.exam_id WHERE ans.id=$1`,
    [req.params.answerId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Answer not found' });
  if (req.teacher && rows[0].teacher_id !== req.teacher.id) {
    return res.status(403).json({ error: 'You do not have access to this submission.' });
  }
  next();
}

router.get('/attempts/:attemptId', optionalTeacherAuth, checkAttemptOwnership, (req, res) => {
  try {
    const { rows: attempt } = db.query(
      `SELECT ea.*, s.name as student_name, s.adm_no, e.title, e.total_marks as exam_total
       FROM exam_attempts ea
       JOIN students s ON s.id=ea.student_id
       JOIN exams e ON e.id=ea.exam_id
       WHERE ea.id=$1`, [req.params.attemptId]
    );
    const { rows: answers } = db.query(
      `SELECT ans.*, q.question_text, q.question_type, q.question_no, q.marks, q.correct_answer
       FROM exam_answers ans JOIN exam_questions q ON q.id=ans.question_id
       WHERE ans.attempt_id=$1 ORDER BY q.question_no`, [req.params.attemptId]
    );
    res.json({ attempt: attempt[0], answers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/answers/:answerId/mark', optionalTeacherAuth, checkAnswerOwnership, (req, res) => {
  try {
    const { marksAwarded, teacherComment } = req.body;
    db.query(
      `UPDATE exam_answers SET marks_awarded=$1,teacher_comment=$2,marked_at=datetime('now') WHERE id=$3`,
      [parseFloat(marksAwarded) || 0, teacherComment || null, req.params.answerId]
    );
    const { rows: ans } = db.query('SELECT attempt_id FROM exam_answers WHERE id=$1', [req.params.answerId]);
    const attemptId = ans[0]?.attempt_id;
    const { rows: scores } = db.query(
      `SELECT q.question_type, COALESCE(SUM(ans.marks_awarded),0) as score
       FROM exam_answers ans JOIN exam_questions q ON q.id=ans.question_id
       WHERE ans.attempt_id=$1 GROUP BY q.question_type`, [attemptId]
    );
    let objScore = 0, theoryScore = 0;
    scores.forEach(s => { if (s.question_type === 'objective') objScore = parseFloat(s.score); else theoryScore = parseFloat(s.score); });
    const total = objScore + theoryScore;
    const { rows: att } = db.query('SELECT total_marks FROM exam_attempts WHERE id=$1', [attemptId]);
    const pct = att[0]?.total_marks > 0 ? (total / att[0].total_marks * 100).toFixed(1) : 0;
    db.query(
      `UPDATE exam_attempts SET theory_score=$1,total_score=$2,objective_score=$3,percentage=$4 WHERE id=$5`,
      [theoryScore, total, objScore, pct, attemptId]
    );
    res.json({ message: 'Marked!', total, percentage: pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
//  STUDENT ROUTES
// ══════════════════════════════════════════

router.get('/student/available', (req, res) => {
  try {
    const { admNo } = req.query;
    const { rows: student } = db.query(
      `SELECT s.*, c.name as class_name FROM students s
       LEFT JOIN classes c ON c.id=s.class_id
       WHERE UPPER(s.adm_no)=UPPER($1)`,
      [admNo]
    );
    if (!student[0]) return res.status(404).json({ error: 'Student not found. Check your admission number.' });
    const { rows } = db.query(
      `SELECT e.*, sub.name as subject_name,
        (SELECT id FROM exam_attempts WHERE exam_id=e.id AND student_id=$1 AND status='submitted') as attempt_id,
        (SELECT status FROM exam_attempts WHERE exam_id=e.id AND student_id=$1 ORDER BY started_at DESC LIMIT 1) as attempt_status,
        (SELECT id FROM exam_attempts WHERE exam_id=e.id AND student_id=$1 AND status='in_progress' LIMIT 1) as active_attempt_id
       FROM exams e LEFT JOIN subjects sub ON sub.id=e.subject_id
       WHERE e.status='published' AND e.class_id=$2
       ORDER BY e.created_at DESC`,
      [student[0].id, student[0].class_id]
    );
    res.json({ student: student[0], exams: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/student/start', (req, res) => {
  try {
    const { admNo, examId } = req.body;
    const { rows: student } = db.query(
      `SELECT s.*, c.name as class_name FROM students s
       LEFT JOIN classes c ON c.id=s.class_id WHERE UPPER(s.adm_no)=UPPER($1)`, [admNo]
    );
    if (!student[0]) return res.status(404).json({ error: 'Student not found' });
    const { rows: exam } = db.query('SELECT * FROM exams WHERE id=$1', [examId]);
    if (!exam[0] || exam[0].status !== 'published') return res.status(400).json({ error: 'Exam not available' });

    const { rows: existing } = db.query(
      'SELECT * FROM exam_attempts WHERE exam_id=$1 AND student_id=$2 ORDER BY started_at DESC LIMIT 1',
      [examId, student[0].id]
    );
    const { rows: questions } = db.query(
      `SELECT id, question_no, question_text, question_type, option_a, option_b, option_c, option_d, marks, image_url
       FROM exam_questions WHERE exam_id=$1 ORDER BY question_no`, [examId]
    );

    if (existing[0]?.status === 'submitted') return res.status(400).json({ error: 'You have already submitted this exam.' });

    if (existing[0]?.status === 'in_progress') {
      const { rows: savedAnswers } = db.query(
        'SELECT question_id, answer FROM exam_answers WHERE attempt_id=$1', [existing[0].id]
      );
      // Seed with the existing attempt id so a resumed/refreshed exam
      // shows questions in the SAME shuffled order as before.
      const shuffledQuestions = seededShuffle(questions, existing[0].id);
      return res.json({ attempt: existing[0], exam: exam[0], student: student[0], questions: shuffledQuestions, savedAnswers, resumed: true });
    }

    const { rows: attempt } = db.query(
      `INSERT INTO exam_attempts (exam_id,student_id,total_marks) VALUES ($1,$2,$3) RETURNING *`,
      [examId, student[0].id, exam[0].total_marks]
    );
    // Seed with the brand-new attempt id — each student attempt gets its
    // own randomized question order, stable for the rest of that attempt.
    const shuffledQuestions = seededShuffle(questions, attempt[0].id);
    res.json({ attempt: attempt[0], exam: exam[0], student: student[0], questions: shuffledQuestions, resumed: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/student/save-answer', (req, res) => {
  try {
    const { attemptId, questionId, answer } = req.body;
    const { rows: existing } = db.query(
      'SELECT id FROM exam_answers WHERE attempt_id=$1 AND question_id=$2', [attemptId, questionId]
    );
    if (existing[0]) {
      db.query('UPDATE exam_answers SET answer=$1 WHERE id=$2', [answer, existing[0].id]);
    } else {
      db.query(
        'INSERT INTO exam_answers (attempt_id,question_id,answer) VALUES ($1,$2,$3)',
        [attemptId, questionId, answer]
      );
    }
    res.json({ saved: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/student/submit', (req, res) => {
  try {
    const { attemptId, answers, timeTaken } = req.body;
    const { rows: attempt } = db.query('SELECT * FROM exam_attempts WHERE id=$1', [attemptId]);
    if (!attempt[0]) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt[0].status === 'submitted') return res.status(400).json({ error: 'Already submitted' });

    const answerMap = {};
    (answers || []).forEach(a => { answerMap[a.questionId] = a.answer; });

    // Every question in the exam gets a row — including theory questions,
    // which never have a typed answer since students write those on paper.
    // Without this, theory questions would have nothing for the teacher to
    // mark and nothing for the student to review after submission.
    const { rows: allQuestions } = db.query(
      'SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY question_no', [attempt[0].exam_id]
    );

    let objScore = 0;
    db.query('DELETE FROM exam_answers WHERE attempt_id=$1', [attemptId]);

    for (const q of allQuestions) {
      const studentAnswer = answerMap[q.id] !== undefined ? answerMap[q.id] : null;
      let isCorrect = null, marksAwarded = 0;
      if (q.question_type === 'objective') {
        isCorrect = (studentAnswer || '').toUpperCase() === (q.correct_answer || '').toUpperCase();
        marksAwarded = isCorrect ? q.marks : 0;
        objScore += marksAwarded;
      }
      db.query(
        `INSERT INTO exam_answers (attempt_id,question_id,answer,is_correct,marks_awarded) VALUES ($1,$2,$3,$4,$5)`,
        [attemptId, q.id, studentAnswer, isCorrect === null ? null : (isCorrect ? 1 : 0), marksAwarded]
      );
    }

    // The exam's total_marks field is set by the teacher when creating the exam
    // (often a round number like 100) and may not match the actual sum of
    // objective question marks present. For an accurate "X/Y" score display,
    // we calculate the real objective total directly from the questions themselves.
    const { rows: objTotalRows } = db.query(
      `SELECT COALESCE(SUM(marks),0) as total FROM exam_questions WHERE exam_id=$1 AND question_type='objective'`,
      [attempt[0].exam_id]
    );
    const objectiveTotal = objTotalRows[0]?.total || 0;

    const { rows: exam } = db.query('SELECT * FROM exams WHERE id=$1', [attempt[0].exam_id]);
    const totalMarks = exam[0]?.total_marks || 100;
    const pct = (objScore / totalMarks * 100).toFixed(1);
    db.query(
      `UPDATE exam_attempts SET status='submitted',submitted_at=datetime('now'),time_taken_minutes=$1,
       objective_score=$2,total_score=$2,percentage=$3 WHERE id=$4`,
      [parseInt(timeTaken) || 0, objScore, pct, attemptId]
    );
    const { rows: updated } = db.query('SELECT * FROM exam_attempts WHERE id=$1', [attemptId]);
    res.json({ attempt: updated[0], objectiveScore: objScore, objectiveTotal, percentage: pct, message: 'Submitted successfully!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/student/result/:attemptId', (req, res) => {
  try {
    const { admNo } = req.query;
    const { rows: attempt } = db.query(
      `SELECT ea.*, e.title, e.duration_minutes, e.total_marks as exam_total_marks,
              s.name as student_name, s.adm_no, sub.name as subject_name
       FROM exam_attempts ea JOIN exams e ON e.id=ea.exam_id
       JOIN students s ON s.id=ea.student_id LEFT JOIN subjects sub ON sub.id=e.subject_id
       WHERE ea.id=$1`, [req.params.attemptId]
    );
    if (!attempt[0]) return res.status(404).json({ error: 'Result not found' });
    // Only the student who sat this exact attempt can view it — prevents
    // guessing another student's attempt id, and prevents a student from
    // peeking at correct answers before their own exam is submitted.
    if (admNo && String(attempt[0].adm_no).toUpperCase() !== String(admNo).toUpperCase()) {
      return res.status(403).json({ error: 'This result does not belong to you' });
    }
    if (attempt[0].status !== 'submitted') {
      return res.status(400).json({ error: 'This exam has not been submitted yet' });
    }
    const { rows: answers } = db.query(
      `SELECT ans.*, q.question_text, q.question_type, q.question_no, q.marks,
              q.correct_answer, q.option_a, q.option_b, q.option_c, q.option_d
       FROM exam_answers ans JOIN exam_questions q ON q.id=ans.question_id
       WHERE ans.attempt_id=$1 ORDER BY q.question_no`, [req.params.attemptId]
    );
    res.json({ attempt: attempt[0], answers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
