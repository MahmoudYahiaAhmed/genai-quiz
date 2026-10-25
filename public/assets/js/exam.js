// Student flow: landing → exam (levels, navigator, timer, autosave) → results.
import { backend, IS_LOCAL_DEMO } from "./backend.js";
import { LEVELS, LEVEL_BY_KEY, SESSIONS, $, esc, richText, codeBlock, highlightWithin, toast, fmtDuration, seededShuffle, friendlyError } from "./shared.js";
import { renderResults } from "./results.js";

const app = $("#app");
const topRight = $("#topbar-right");
const STORE_KEY = "genai-quiz-attempt";
const HEARTBEAT_MS = 10000;
const SAVE_DEBOUNCE_MS = 1500;
const LOW_TIME_MS = 5 * 60 * 1000;
const LETTERS = "ABCDEF";

let exam = null; // the in-progress attempt (see startExam)
const timers = { tick: null, beat: null, save: null };

// ---------------------------------------------------------------- storage

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? null;
  } catch {
    return null;
  }
}
function writeStore(value) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    /* private mode: the server copy (heartbeat) is still the source of truth */
  }
}
function persist() {
  if (!exam) return;
  writeStore({
    id: exam.id, token: exam.token, name: exam.name, questions: exam.questions,
    answers: exam.answers, flags: [...exam.flags], current: exam.current, tabSwitches: exam.tabSwitches,
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  const stored = readStore();
  if (stored?.id && stored?.token) {
    try {
      const res = await backend.resumeAttempt(stored.id, stored.token);
      if (res.status === "in_progress") return startExam(res, stored);
      return showResults(res.result, stored.questions ?? [], stored.name);
    } catch (err) {
      if (!/not found/i.test(err.message)) {
        return showFatal(friendlyError(err), true);
      }
      localStorage.removeItem(STORE_KEY);
    }
  }
  return showLanding();
}

function showFatal(message, retry = false) {
  app.innerHTML = `<div class="center-screen"><div class="card pad" style="max-width:520px">
    <h2 style="margin-top:0">Something went wrong</h2><p class="muted">${esc(message)}</p>
    ${retry ? '<button class="btn primary" id="retry">Try again</button>' : ""}</div></div>`;
  $("#retry")?.addEventListener("click", () => location.reload());
}

// ---------------------------------------------------------------- landing

async function showLanding() {
  topRight.innerHTML = "";
  let info;
  try {
    info = await backend.getExamInfo();
  } catch (err) {
    return showFatal(friendlyError(err), true);
  }
  $("#brand-title").textContent = info.title;
  document.title = info.title;

  const ladder = LEVELS.map(
    (l) => `<div class="ladder-step"><div class="n" style="background:var(--${l.key})">${l.stage}</div>
      <div><b>${l.label}</b> <span class="muted small">· ${l.points} pt${l.points > 1 ? "s" : ""} each</span></div></div>`
  ).join("");

  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">Sessions 0 → 25 · Python, APIs, Transformers, RAG, LangChain, LangGraph</div>
        <h1>${esc(info.title)}</h1>
        <p class="muted" style="font-size:17px;margin:0">Climb four levels — from fundamentals to extreme edge cases. Read code, predict outputs, debug logic and make design calls. At the end you get your score plus a full review with explanations so you learn from every question.</p>
        <div class="stats-row">
          <div class="stat"><b>${info.question_count}</b><span>questions</span></div>
          <div class="stat"><b>${info.time_limit_minutes} min</b><span>time limit</span></div>
          <div class="stat"><b>4</b><span>difficulty levels</span></div>
        </div>
        <div class="ladder">${ladder}</div>
      </div>
      <div class="card pad">
        ${info.exam_open ? `
        <h2 style="margin-top:0">Start your exam</h2>
        <form id="start-form" class="form-grid" novalidate>
          <label class="field">Full name<input class="input" name="name" autocomplete="name" required minlength="3" maxlength="80" placeholder="e.g. Sara Ahmed"></label>
          <label class="field">Student ID or email<input class="input" name="sid" required maxlength="64" placeholder="e.g. 2024-117 or sara@mail.com" autocapitalize="off"></label>
          ${info.needs_code ? '<label class="field">Access code<input class="input" name="code" required autocomplete="off" placeholder="Given by your instructor"></label>' : ""}
          <div id="start-error" class="error-box hidden"></div>
          <ul class="rules">
            <li>The timer starts when you press Start and keeps running if you close the page.</li>
            <li>Your answers are saved automatically — you can reload safely on this device.</li>
            <li>Leaving the exam tab is recorded${info.max_tab_switches ? ` and after ${info.max_tab_switches} times your exam ends` : ""}.</li>
            <li>Move freely between questions, flag the ones to revisit, then submit.</li>
          </ul>
          <button class="btn primary lg" type="submit" id="start-btn">Start exam →</button>
        </form>` : `
        <h2 style="margin-top:0">The exam is not open yet</h2>
        <p class="muted">Your instructor will open it at the start of the exam. Keep this page open — it checks again automatically.</p>
        <div class="spinner"></div>`}
        ${IS_LOCAL_DEMO ? '<p class="muted small" style="margin-bottom:0">Local demo mode — data stays in this browser.</p>' : ""}
      </div>
    </section>`;

  if (!info.exam_open) {
    setTimeout(showLanding, 15000);
    return;
  }
  $("#start-form").addEventListener("submit", onStart);
}

async function onStart(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $("#start-error");
  const btn = $("#start-btn");
  const data = Object.fromEntries(new FormData(form));
  const name = String(data.name ?? "").trim();
  const studentId = String(data.sid ?? "").trim();
  const fail = (msg) => {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  };
  if (name.length < 3) return fail("Please enter your full name.");
  if (!/^[A-Za-z0-9._@+-]{2,64}$/.test(studentId)) return fail("Student ID / email may only contain letters, digits and . _ @ + -");
  errBox.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Preparing your exam…";
  try {
    const payload = await backend.startAttempt({ name, studentId, code: String(data.code ?? "").trim() });
    startExam(payload, null);
  } catch (err) {
    fail(friendlyError(err));
    btn.disabled = false;
    btn.textContent = "Start exam →";
  }
}

// ---------------------------------------------------------------- exam

function startExam(payload, stored) {
  const sameAttempt = stored?.id === payload.attempt_id;
  const serverAnswers = payload.answers ?? {};
  // Local copy wins when it has more answers (it may hold changes the last heartbeat missed).
  const localAnswers = sameAttempt ? stored.answers ?? {} : {};
  exam = {
    id: payload.attempt_id,
    token: payload.token,
    name: payload.student_name,
    title: payload.title,
    deadline: Date.parse(payload.deadline),
    offset: Date.parse(payload.server_now) - Date.now(),
    questions: payload.questions,
    answers: Object.keys(localAnswers).length >= Object.keys(serverAnswers).length ? { ...serverAnswers, ...localAnswers } : { ...localAnswers, ...serverAnswers },
    flags: new Set(sameAttempt ? stored.flags ?? [] : []),
    current: sameAttempt ? Math.min(stored.current ?? 0, payload.questions.length - 1) : 0,
    tabSwitches: Math.max(payload.tab_switches ?? 0, sameAttempt ? stored.tabSwitches ?? 0 : 0),
    maxTab: payload.max_tab_switches ?? 0,
    dirty: true,
    saving: false,
    finished: false,
  };
  persist();
  $("#brand-title").textContent = exam.title;
  renderExamShell();
  renderQuestion();
  startTimers();
  sync();
}

function isAnswered(q) {
  const v = exam.answers[q.id];
  return !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));
}

function optionOrder(q) {
  const idx = q.options.map((_, i) => i);
  return q.shuffle ? seededShuffle(idx, exam.id + q.id) : idx;
}

function renderExamShell() {
  topRight.innerHTML = `
    <span class="save-state" id="save-state"><span class="dot"></span>Saved</span>
    <span class="muted small hide-sm">${esc(exam.name)}</span>
    <span class="timer" id="timer" title="Time remaining">--:--</span>
    <button class="btn primary sm" id="submit-top">Submit</button>`;
  $("#submit-top").addEventListener("click", confirmSubmit);

  app.innerHTML = `
    <div class="exam">
      <aside class="card nav-panel" aria-label="Question navigator">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px">
          <b>Progress</b><span class="muted" id="progress-label"></span>
        </div>
        <div class="progress" style="margin-bottom:16px"><div id="progress-bar"></div></div>
        <div id="nav"></div>
        <div class="legend">
          <span><i style="background:var(--accent-soft)"></i>Answered</span>
          <span><i style="background:var(--surface-2)"></i>Open</span>
          <span><i style="background:var(--warn);border-radius:50%"></i>Flagged</span>
        </div>
        <p class="muted small" style="margin:14px 0 0">Keys: <code>A–F</code> choose · <code>←</code><code>→</code> move · <code>F</code> flag</p>
      </aside>
      <section class="card q-card no-select" id="q-card" aria-live="polite"></section>
    </div>`;

  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest(".nav-btn");
    if (b) goTo(Number(b.dataset.i));
  });
  renderNav();
}

function renderNav() {
  const groups = LEVELS.map((l) => ({ l, items: exam.questions.map((q, i) => ({ q, i })).filter((x) => x.q.difficulty === l.key) })).filter((g) => g.items.length);
  $("#nav").innerHTML = groups
    .map(({ l, items }) => {
      const done = items.filter((x) => isAnswered(x.q)).length;
      return `<div class="nav-group">
        <h4><span class="pill lvl-${l.key}">Level ${l.stage} · ${l.label}</span><span class="muted">${done}/${items.length}</span></h4>
        <div class="nav-grid">${items
          .map(({ q, i }) => `<button class="nav-btn ${isAnswered(q) ? "answered" : ""} ${exam.flags.has(q.id) ? "flag" : ""} ${i === exam.current ? "current" : ""}" data-i="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`)
          .join("")}</div></div>`;
    })
    .join("");
  const answered = exam.questions.filter(isAnswered).length;
  $("#progress-label").textContent = `${answered} / ${exam.questions.length}`;
  $("#progress-bar").style.width = `${(answered * 100) / exam.questions.length}%`;
}

function levelBanner(q, i) {
  const prev = exam.questions[i - 1];
  if (prev && prev.difficulty === q.difficulty) return "";
  const l = LEVEL_BY_KEY[q.difficulty];
  const blurbs = {
    easy: "Warm-up: core definitions and ideas.",
    medium: "Apply the concepts and read short code.",
    hard: "Predict outputs, spot bugs, compare trade-offs.",
    extreme: "Multi-step reasoning and subtle edge cases. Take your time.",
  };
  return `<div class="level-banner lvl-${l.key}">Level ${l.stage} · ${l.label} <span style="font-weight:500">— ${blurbs[l.key]}</span></div>`;
}

function renderQuestion() {
  const i = exam.current;
  const q = exam.questions[i];
  const l = LEVEL_BY_KEY[q.difficulty];
  const value = exam.answers[q.id];
  let answerUi = "";
  if (q.type === "text") {
    answerUi = `<input class="input text-answer" id="text-answer" autocomplete="off" spellcheck="false" maxlength="300" placeholder="Type your answer…" value="${esc(value ?? "")}">
      <div class="q-hint">Spaces and letter case are ignored when grading.</div>`;
  } else {
    const chosen = new Set(Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
    answerUi = `<div class="options" role="${q.type === "multi" ? "group" : "radiogroup"}">${optionOrder(q)
      .map((orig, pos) => `<button type="button" class="option ${q.type === "multi" ? "multi" : ""} ${chosen.has(orig) ? "selected" : ""}" data-orig="${orig}"
          role="${q.type === "multi" ? "checkbox" : "radio"}" aria-checked="${chosen.has(orig)}">
          <span class="key">${LETTERS[pos]}</span><span class="txt">${richText(q.options[orig])}</span></button>`)
      .join("")}</div>
      ${q.type === "multi" ? '<div class="q-hint">Select all correct options — partial selections score zero.</div>' : ""}`;
  }

  const card = $("#q-card");
  card.innerHTML = `
    ${levelBanner(q, i)}
    <div class="q-meta">
      <span class="q-number">Question ${i + 1} of ${exam.questions.length}</span>
      <span class="pill lvl-${q.difficulty}">${l.label} · ${q.points} pt${q.points > 1 ? "s" : ""}</span>
      <span class="pill neutral" title="${esc(SESSIONS[q.session] ?? "")}">Session ${q.session}${q.topic ? ` · ${esc(q.topic)}` : ""}</span>
      ${q.type === "multi" ? '<span class="pill neutral">Multiple answers</span>' : ""}
      ${q.type === "text" ? '<span class="pill neutral">Type the answer</span>' : ""}
    </div>
    <div class="q-prompt">${richText(q.prompt)}</div>
    ${codeBlock(q.code)}
    ${answerUi}
    <div class="q-actions">
      <button class="btn" id="prev" ${i === 0 ? "disabled" : ""}>← Previous</button>
      <button class="btn ${exam.flags.has(q.id) ? "flagged" : ""}" id="flag">⚑ ${exam.flags.has(q.id) ? "Flagged" : "Flag"}</button>
      <span class="spacer"></span>
      ${i === exam.questions.length - 1 ? '<button class="btn primary" id="finish">Review & submit</button>' : '<button class="btn primary" id="next">Next →</button>'}
    </div>`;
  highlightWithin(card);

  card.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => choose(q, Number(b.dataset.orig))));
  const input = $("#text-answer");
  input?.addEventListener("input", () => setAnswer(q, input.value.trim() ? input.value : null));
  $("#prev")?.addEventListener("click", () => goTo(i - 1));
  $("#next")?.addEventListener("click", () => goTo(i + 1));
  $("#finish")?.addEventListener("click", confirmSubmit);
  $("#flag").addEventListener("click", () => toggleFlag(q));
  renderNav();
}

function choose(q, orig) {
  if (q.type === "single") {
    setAnswer(q, orig);
  } else {
    const cur = Array.isArray(exam.answers[q.id]) ? exam.answers[q.id] : [];
    const next = cur.includes(orig) ? cur.filter((x) => x !== orig) : [...cur, orig].sort((a, b) => a - b);
    setAnswer(q, next.length ? next : null);
  }
  $("#q-card").querySelectorAll(".option").forEach((b) => {
    const v = exam.answers[q.id];
    const on = Array.isArray(v) ? v.includes(Number(b.dataset.orig)) : v === Number(b.dataset.orig);
    b.classList.toggle("selected", on);
    b.setAttribute("aria-checked", String(on));
  });
}

function setAnswer(q, value) {
  const { [q.id]: _removed, ...rest } = exam.answers;
  exam.answers = value === null ? rest : { ...rest, [q.id]: value };
  exam.dirty = true;
  persist();
  renderNav();
  setSaveState("pending");
  clearTimeout(timers.save);
  timers.save = setTimeout(sync, SAVE_DEBOUNCE_MS);
}

function toggleFlag(q) {
  const next = new Set(exam.flags);
  next.has(q.id) ? next.delete(q.id) : next.add(q.id);
  exam.flags = next;
  persist();
  renderQuestion();
}

function goTo(i) {
  if (i < 0 || i >= exam.questions.length) return;
  exam.current = i;
  persist();
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- sync & timer

function setSaveState(kind) {
  const box = $("#save-state");
  if (!box) return;
  const map = {
    pending: ['<span class="dot"></span>Saving…'],
    saved: ['<span class="dot live"></span>Saved'],
    offline: ['<span class="dot" style="background:var(--bad)"></span>Offline — retrying'],
  };
  box.innerHTML = map[kind][0];
}

async function sync() {
  if (!exam || exam.finished || exam.saving) return;
  exam.saving = true;
  const sentAnswers = exam.answers;
  try {
    const res = await backend.heartbeat(exam.id, exam.token, sentAnswers, exam.tabSwitches);
    if (exam.answers === sentAnswers) exam.dirty = false;
    if (res.server_now) exam.offset = Date.parse(res.server_now) - Date.now();
    setSaveState(exam.dirty ? "pending" : "saved");
    if (res.status !== "in_progress") return finish(res.result);
  } catch (err) {
    setSaveState("offline");
  } finally {
    if (exam) exam.saving = false;
  }
}

function startTimers() {
  stopTimers();
  timers.tick = setInterval(tick, 1000);
  timers.beat = setInterval(sync, HEARTBEAT_MS);
  tick();
}
function stopTimers() {
  clearInterval(timers.tick);
  clearInterval(timers.beat);
  clearTimeout(timers.save);
}

function tick() {
  if (!exam || exam.finished) return;
  const left = exam.deadline - (Date.now() + exam.offset);
  const t = $("#timer");
  if (t) {
    t.textContent = fmtDuration(left);
    t.classList.toggle("low", left < LOW_TIME_MS);
  }
  if (left <= 0) {
    toast("Time is up — submitting your answers.", "warn");
    submit();
  }
}

// ---------------------------------------------------------------- submit & finish

function confirmSubmit() {
  const unanswered = exam.questions.filter((q) => !isAnswered(q)).length;
  const flagged = exam.flags.size;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">Submit your exam?</h3>
      <p class="muted">You answered <b>${exam.questions.length - unanswered}</b> of <b>${exam.questions.length}</b> questions.</p>
      ${unanswered ? `<div class="notice" style="margin-bottom:8px">${unanswered} question${unanswered > 1 ? "s are" : " is"} still unanswered.</div>` : ""}
      ${flagged ? `<p class="muted">${flagged} flagged question${flagged > 1 ? "s" : ""} to double-check.</p>` : ""}
      <p class="muted small">After submitting you cannot change your answers.</p>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">Keep working</button>
        ${unanswered ? '<button class="btn" data-act="jump">Go to first unanswered</button>' : ""}
        <button class="btn primary" data-act="ok">Submit now</button>
      </div></div>`;
  document.body.append(modal);
  modal.addEventListener("click", (e) => {
    const act = e.target.dataset?.act ?? (e.target === modal ? "cancel" : null);
    if (!act) return;
    modal.remove();
    if (act === "ok") submit();
    if (act === "jump") goTo(exam.questions.findIndex((q) => !isAnswered(q)));
  });
}

async function submit() {
  if (!exam || exam.finished || exam.submitting) return;
  exam.submitting = true;
  stopTimers();
  app.querySelectorAll("button").forEach((b) => (b.disabled = true));
  toast("Submitting…");
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await backend.submitAttempt(exam.id, exam.token, exam.answers);
      return finish(result);
    } catch (err) {
      if (/not found/i.test(err.message)) break;
      toast(`Could not reach the server (try ${attempt}/5)…`, "error");
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  exam.submitting = false;
  toast("Submission failed. Your answers are saved — check your connection and press Submit again.", "error", 8000);
  app.querySelectorAll("button").forEach((b) => (b.disabled = false));
  startTimers();
}

function finish(result) {
  if (!exam) return;
  stopTimers();
  exam.finished = true;
  writeStore({ id: exam.id, token: exam.token, name: exam.name, questions: exam.questions, finished: true });
  const { questions, name } = exam;
  exam = null;
  document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove());
  const notes = { submitted: ["Exam submitted.", "success"], terminated: ["Your exam was ended by the instructor.", "error"], expired: ["Time is up — answers submitted.", "warn"] };
  const [msg, kind] = notes[result.status] ?? notes.submitted;
  toast(msg, kind, 4000);
  showResults(result, questions, name);
}

function showResults(result, questions, name) {
  topRight.innerHTML = '<button class="btn sm" id="exit">Exit</button>';
  $("#exit").addEventListener("click", () => {
    localStorage.removeItem(STORE_KEY);
    showLanding();
  });
  renderResults(app, result, questions, { name, onCheckReview: () => recheckReview(questions, name) });
  window.scrollTo({ top: 0 });
}

async function recheckReview(questions, name) {
  const stored = readStore();
  if (!stored?.id) return;
  try {
    const res = await backend.resumeAttempt(stored.id, stored.token);
    if (res.result?.review_state === "open") {
      toast("The review is open — scroll down to learn from every question.", "success");
      showResults(res.result, questions, name);
    } else {
      toast("Not yet — the exam is still open for other students.", "info");
    }
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

// ---------------------------------------------------------------- global listeners

document.addEventListener("visibilitychange", () => {
  if (!exam || exam.finished) return;
  if (document.visibilityState === "hidden") {
    exam.tabSwitches += 1;
    persist();
    sync();
  } else {
    const limit = exam.maxTab ? ` (${exam.tabSwitches}/${exam.maxTab} allowed)` : "";
    toast(`You left the exam window${limit}. This is reported to your instructor.`, "warn", 5000);
  }
});

document.addEventListener("keydown", (e) => {
  if (!exam || exam.finished || document.querySelector(".modal-backdrop")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const q = exam.questions[exam.current];
  if (e.key === "ArrowRight" && !typing) return goTo(exam.current + 1);
  if (e.key === "ArrowLeft" && !typing) return goTo(exam.current - 1);
  if (typing) return;
  if (e.key.toLowerCase() === "f" && !e.repeat) return toggleFlag(q);
  const pos = LETTERS.indexOf(e.key.toUpperCase());
  const digit = Number(e.key) - 1;
  const p = pos >= 0 ? pos : Number.isInteger(digit) && digit >= 0 ? digit : -1;
  if (q.type !== "text" && p >= 0 && p < q.options.length) choose(q, optionOrder(q)[p]);
});

["copy", "cut", "contextmenu"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    if (exam && !exam.finished && e.target.closest?.("#q-card") && !(e.target instanceof HTMLInputElement)) e.preventDefault();
  })
);

window.addEventListener("beforeunload", (e) => {
  if (exam && !exam.finished) {
    persist();
    e.preventDefault();
  }
});

boot();
