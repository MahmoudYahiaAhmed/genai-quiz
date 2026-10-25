// Backend adapters with one interface:
//   SupabaseBackend — production (GitHub Pages). Grading happens in Postgres.
//   LocalBackend    — demo mode for previewing on your own machine. Reads the
//                     answer key from ../bank/build/questions.json (never deployed).

const cfg = window.QUIZ_CONFIG ?? {};
export const IS_LOCAL_DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

// ---------------------------------------------------------------- Supabase

class SupabaseBackend {
  constructor() {
    this.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, storageKey: "genai-quiz-admin" },
    });
  }

  async rpc(name, args = {}) {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  }

  async table(promise) {
    const { data, error } = await promise;
    if (error) throw new Error(error.message);
    return data;
  }

  // ----- student
  getExamInfo() {
    return this.rpc("get_exam_info");
  }
  startAttempt({ name, studentId, code }) {
    return this.rpc("start_attempt", { p_name: name, p_student_id: studentId, p_code: code ?? "", p_user_agent: navigator.userAgent });
  }
  resumeAttempt(id, token) {
    return this.rpc("resume_attempt", { p_attempt: id, p_token: token });
  }
  heartbeat(id, token, answers, tabSwitches) {
    return this.rpc("heartbeat", { p_attempt: id, p_token: token, p_answers: answers, p_tab_switches: tabSwitches });
  }
  submitAttempt(id, token, answers) {
    return this.rpc("submit_attempt", { p_attempt: id, p_token: token, p_answers: answers });
  }

  // ----- admin
  async signIn(email, password) {
    const { error } = await this.db.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return this.checkAdmin();
  }
  async signOut() {
    await this.db.auth.signOut();
  }
  async currentAdmin() {
    const { data } = await this.db.auth.getSession();
    if (!data.session) return null;
    return (await this.checkAdmin()) ? data.session.user.email : null;
  }
  async checkAdmin() {
    // RLS returns zero rows to anyone who is not listed in public.admins.
    const rows = await this.table(this.db.from("settings").select("id"));
    if (!rows.length) {
      await this.db.auth.signOut();
      throw new Error("This account is not an exam admin.");
    }
    return true;
  }
  listAttempts() {
    return this.table(
      this.db.from("attempts")
        .select("id,student_name,student_id,status,question_ids,answered_count,tab_switches,score,max_score,percent,started_at,deadline,last_seen,submitted_at,terminated_reason")
        .order("started_at", { ascending: false })
        .limit(1000)
    );
  }
  async getAttempt(id) {
    const rows = await this.table(this.db.from("attempts").select("*").eq("id", id));
    return rows[0] ?? null;
  }
  async getSettings() {
    const rows = await this.table(this.db.from("settings").select("*").eq("id", 1));
    return rows[0];
  }
  updateSettings(patch) {
    return this.table(this.db.from("settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1));
  }
  listQuestions() {
    return this.table(this.db.from("questions").select("id,session,difficulty,type,topic,prompt,code,options,points,active").order("id"));
  }
  terminate(ids, reason) {
    return this.rpc("admin_terminate", { p_ids: ids, p_reason: reason });
  }
  terminateAll(reason) {
    return this.rpc("admin_terminate_all", { p_reason: reason });
  }
  deleteAttempt(id) {
    return this.table(this.db.from("attempts").delete().eq("id", id));
  }
  questionStats() {
    return this.rpc("admin_question_stats");
  }
  async listRoster() {
    return (await this.table(this.db.from("roster").select("student_id").order("student_id"))).map((r) => r.student_id);
  }
  async setRoster(ids) {
    await this.table(this.db.from("roster").delete().neq("student_id", ""));
    if (ids.length) await this.table(this.db.from("roster").insert(ids.map((student_id) => ({ student_id }))));
  }
}

// ---------------------------------------------------------------- Local demo

const LS_KEY = "genai-quiz-local-db";
const DEFAULT_SETTINGS = {
  id: 1,
  exam_open: true,
  title: "Generative AI — Final Exam (local demo)",
  sessions: Array.from({ length: 26 }, (_, i) => i),
  counts: { easy: 18, medium: 20, hard: 15, extreme: 7 },
  time_limit_minutes: 90,
  max_attempts: 50,
  max_tab_switches: 0,
  show_review: true,
  access_code: "",
};
const DEMO_ADMIN = { email: "admin@demo.local", password: "demo" };

const normText = (t) => String(t ?? "").replace(/\s+/g, "").toLowerCase().replaceAll('"', "'");
const sortedInts = (a) => (Array.isArray(a) ? [...new Set(a.map(Number))].sort((x, y) => x - y).join(",") : "");
const answeredCount = (ans) => Object.values(ans).filter((v) => v !== null && v !== "" && !(Array.isArray(v) && !v.length)).length;

function isCorrect(type, key, given) {
  if (given === undefined || given === null) return false;
  if (type === "single") return Number(given) === key;
  if (type === "multi") return sortedInts(given) === sortedInts(key);
  if (type === "text") return key.some((k) => normText(k) === normText(given));
  return false;
}

class LocalBackend {
  constructor() {
    this.bank = null;
  }

  async loadBank() {
    if (this.bank) return this.bank;
    const res = await fetch("../bank/build/questions.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Not configured: set SUPABASE_URL and SUPABASE_ANON_KEY in config.js (local demo needs `node tools/build.mjs`).");
    }
    this.bank = new Map((await res.json()).map((q) => [q.id, q]));
    return this.bank;
  }

  read() {
    try {
      const db = JSON.parse(localStorage.getItem(LS_KEY));
      if (db?.settings) return db;
    } catch {
      /* fall through to a fresh db */
    }
    return { settings: { ...DEFAULT_SETTINGS }, attempts: [] };
  }
  write(db) {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  }
  update(fn) {
    const db = fn(this.read());
    this.write(db);
    return db;
  }

  publicQuestions(ids) {
    return ids.map((id) => {
      const { answer, explanation, ...rest } = this.bank.get(id);
      return rest;
    });
  }

  grade(attempt, status, reason = null) {
    if (attempt.status !== "in_progress") return attempt;
    let score = 0;
    let max = 0;
    const results = attempt.question_ids.map((id) => {
      const q = this.bank.get(id);
      const ok = isCorrect(q.type, q.answer, attempt.answers[id]);
      max += q.points;
      if (ok) score += q.points;
      return { id, session: q.session, difficulty: q.difficulty, points: q.points, correct: ok, given: attempt.answers[id] ?? null, answer: q.answer, explanation: q.explanation };
    });
    return {
      ...attempt,
      status,
      score,
      max_score: max,
      percent: max ? Math.round((score * 1000) / max) / 10 : 0,
      results,
      submitted_at: new Date().toISOString(),
      terminated_reason: reason,
    };
  }

  expireIfDue(a) {
    return a.status === "in_progress" && Date.now() > Date.parse(a.deadline) + 120000 ? this.grade(a, "expired", "Time limit reached") : a;
  }

  studentResult(a, settings) {
    const groups = (field) =>
      a.results.reduce((m, r) => {
        const cur = m[r[field]] ?? { got: 0, max: 0, right: 0, total: 0 };
        return { ...m, [r[field]]: { got: cur.got + (r.correct ? r.points : 0), max: cur.max + r.points, right: cur.right + (r.correct ? 1 : 0), total: cur.total + 1 } };
      }, {});
    const reviewState = !settings.show_review ? "hidden" : settings.exam_open ? "locked" : "open";
    return {
      status: a.status, score: a.score, max_score: a.max_score, percent: a.percent, terminated_reason: a.terminated_reason,
      submitted_at: a.submitted_at, question_count: a.question_ids.length, levels: groups("difficulty"), sessions: groups("session"),
      review_state: reviewState, results: reviewState === "open" ? a.results : [],
    };
  }

  payload(a, s) {
    return {
      status: a.status, attempt_id: a.id, token: a.token, deadline: a.deadline, server_now: new Date().toISOString(),
      title: s.title, student_name: a.student_name, student_id: a.student_id, max_tab_switches: s.max_tab_switches,
      tab_switches: a.tab_switches, questions: this.publicQuestions(a.question_ids), answers: a.answers,
    };
  }

  findAttempt(db, id, token) {
    const a = db.attempts.find((x) => x.id === id && (token === undefined || x.token === token));
    if (!a) throw new Error("Attempt not found.");
    return a;
  }

  replaceAttempt(db, next) {
    return { ...db, attempts: db.attempts.map((x) => (x.id === next.id ? next : x)) };
  }

  // ----- student
  async getExamInfo() {
    await this.loadBank();
    const s = this.read().settings;
    return {
      exam_open: s.exam_open, title: s.title, time_limit_minutes: s.time_limit_minutes,
      question_count: Object.values(s.counts).reduce((a, b) => a + Number(b), 0),
      needs_code: !!s.access_code, max_tab_switches: s.max_tab_switches,
    };
  }

  async startAttempt({ name, studentId, code }) {
    const bank = await this.loadBank();
    const db = this.read();
    const s = db.settings;
    const sid = String(studentId ?? "").trim().toLowerCase();
    const nm = String(name ?? "").trim();
    if (!s.exam_open) throw new Error("The exam is closed right now.");
    if (s.access_code && code !== s.access_code) throw new Error("Wrong access code.");
    if (nm.length < 3 || nm.length > 80) throw new Error("Please enter your full name (3–80 characters).");
    if (!/^[a-z0-9._@+-]{2,64}$/.test(sid)) throw new Error("Student ID / email may only contain letters, digits and . _ @ + - (2–64 chars).");
    if (db.roster?.length && !db.roster.includes(sid)) throw new Error("This student ID is not on the class list. Check it or ask your instructor.");
    const attempts = db.attempts.map((a) => this.expireIfDue(a));
    if (attempts.some((a) => a.student_id === sid && a.status === "in_progress")) {
      throw new Error("You already have an exam in progress. Continue it on the device where you started, or ask your instructor to reset it.");
    }
    if (attempts.filter((a) => a.student_id === sid).length >= s.max_attempts) {
      throw new Error("You have used all of your allowed attempts.");
    }
    const pool = [...bank.values()].filter((q) => s.sessions.includes(q.session));
    // questions sharing a `group` never land in the same attempt
    const usedGroups = new Set();
    const ids = ["easy", "medium", "hard", "extreme"].flatMap((lvl) => {
      const picked = [];
      for (const q of pool.filter((x) => x.difficulty === lvl).sort(() => Math.random() - 0.5)) {
        if (picked.length >= Number(s.counts[lvl] ?? 0)) break;
        if (q.group && usedGroups.has(q.group)) continue;
        if (q.group) usedGroups.add(q.group);
        picked.push(q.id);
      }
      return picked;
    });
    if (!ids.length) throw new Error("No questions match the exam settings.");
    const now = Date.now();
    const attempt = {
      id: crypto.randomUUID(), token: crypto.randomUUID(), student_name: nm, student_id: sid, status: "in_progress",
      question_ids: ids, answers: {}, answered_count: 0, tab_switches: 0, score: null, max_score: null, percent: null, results: null,
      started_at: new Date(now).toISOString(), deadline: new Date(now + s.time_limit_minutes * 60000).toISOString(),
      last_seen: new Date(now).toISOString(), submitted_at: null, terminated_reason: null, user_agent: navigator.userAgent.slice(0, 300),
    };
    this.write({ ...db, attempts: [attempt, ...attempts] });
    return this.payload(attempt, s);
  }

  async resumeAttempt(id, token) {
    await this.loadBank();
    const db = this.read();
    const a = this.expireIfDue(this.findAttempt(db, id, token));
    this.write(this.replaceAttempt(db, a));
    if (a.status !== "in_progress") return { status: a.status, result: this.studentResult(a, db.settings) };
    return this.payload(a, db.settings);
  }

  async heartbeat(id, token, answers, tabSwitches) {
    await this.loadBank();
    const db = this.read();
    let a = this.findAttempt(db, id, token);
    if (a.status === "in_progress") {
      const inTime = Date.now() <= Date.parse(a.deadline);
      const kept = inTime ? Object.fromEntries(Object.entries(answers ?? {}).filter(([k]) => a.question_ids.includes(k))) : a.answers;
      a = { ...a, answers: kept, answered_count: answeredCount(kept), tab_switches: Math.max(a.tab_switches, tabSwitches ?? 0), last_seen: new Date().toISOString() };
      const s = db.settings;
      a = s.max_tab_switches > 0 && a.tab_switches > s.max_tab_switches ? this.grade(a, "terminated", "Left the exam window too many times") : this.expireIfDue(a);
      this.write(this.replaceAttempt(db, a));
    }
    if (a.status === "in_progress") return { status: a.status, server_now: new Date().toISOString(), deadline: a.deadline };
    return { status: a.status, result: this.studentResult(a, db.settings) };
  }

  async submitAttempt(id, token, answers) {
    await this.heartbeat(id, token, answers, null);
    const db = this.read();
    const a = this.grade(this.findAttempt(db, id, token), "submitted");
    this.write(this.replaceAttempt(db, a));
    return this.studentResult(a, db.settings);
  }

  // ----- admin
  async signIn(email, password) {
    if (email.trim().toLowerCase() !== DEMO_ADMIN.email || password !== DEMO_ADMIN.password) {
      throw new Error(`Invalid login. Local demo credentials: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
    }
    sessionStorage.setItem("genai-quiz-local-admin", "1");
    return true;
  }
  async signOut() {
    sessionStorage.removeItem("genai-quiz-local-admin");
  }
  async currentAdmin() {
    return sessionStorage.getItem("genai-quiz-local-admin") ? DEMO_ADMIN.email : null;
  }
  async listAttempts() {
    await this.loadBank();
    return this.update((db) => ({ ...db, attempts: db.attempts.map((a) => this.expireIfDue(a)) })).attempts;
  }
  async getAttempt(id) {
    return this.read().attempts.find((a) => a.id === id) ?? null;
  }
  async getSettings() {
    return this.read().settings;
  }
  async updateSettings(patch) {
    this.update((db) => ({ ...db, settings: { ...db.settings, ...patch } }));
  }
  async listQuestions() {
    const bank = await this.loadBank();
    return [...bank.values()].map(({ answer, explanation, ...q }) => ({ ...q, active: true }));
  }
  async terminate(ids, reason) {
    await this.loadBank();
    let n = 0;
    this.update((db) => ({
      ...db,
      attempts: db.attempts.map((a) => {
        if (!ids.includes(a.id) || a.status !== "in_progress") return a;
        n += 1;
        return this.grade(a, "terminated", reason);
      }),
    }));
    return n;
  }
  async terminateAll(reason) {
    return this.terminate(this.read().attempts.map((a) => a.id), reason);
  }
  async listRoster() {
    return this.read().roster ?? [];
  }
  async setRoster(ids) {
    this.update((db) => ({ ...db, roster: ids }));
  }
  async deleteAttempt(id) {
    this.update((db) => ({ ...db, attempts: db.attempts.filter((a) => a.id !== id) }));
  }
  async questionStats() {
    const bank = await this.loadBank();
    const agg = new Map();
    for (const a of this.read().attempts) {
      for (const r of a.results ?? []) {
        const cur = agg.get(r.id) ?? { seen: 0, correct: 0 };
        agg.set(r.id, { seen: cur.seen + 1, correct: cur.correct + (r.correct ? 1 : 0) });
      }
    }
    return [...agg.entries()]
      .map(([id, v]) => {
        const q = bank.get(id);
        return { id, session: q.session, difficulty: q.difficulty, topic: q.topic, prompt: q.prompt.slice(0, 140), ...v, rate: Math.round((v.correct * 1000) / v.seen) / 10 };
      })
      .sort((x, y) => x.rate - y.rate);
  }
}

export const backend = IS_LOCAL_DEMO ? new LocalBackend() : new SupabaseBackend();
