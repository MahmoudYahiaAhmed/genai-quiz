// Instructor dashboard: sign in, watch attempts live, terminate, configure, export.
import { backend, IS_LOCAL_DEMO } from "./backend.js";
import { LEVELS, SESSIONS, $, esc, richText, codeBlock, highlightWithin, toast, fmtTime, fmtDuration, friendlyError, askDialog } from "./shared.js";

const app = $("#app");
const topRight = $("#topbar-right");
const REFRESH_MS = 5000;
const ONLINE_WINDOW_MS = 35000;

const view = {
  tab: "attempts",
  attempts: [],
  questions: null,
  filter: { q: "", status: "all" },
  refreshTimer: null,
  email: null,
};

// ---------------------------------------------------------------- auth

async function boot() {
  try {
    view.email = await backend.currentAdmin();
  } catch {
    view.email = null;
  }
  return view.email ? showDashboard() : showLogin();
}

function showLogin(message = "") {
  stopRefresh();
  topRight.innerHTML = "";
  app.innerHTML = `
    <div class="center-screen">
      <form class="card pad" id="login" style="width:min(420px,100%)" novalidate>
        <div class="eyebrow">Instructor only</div>
        <h2 style="margin:6px 0 18px">Sign in to the control room</h2>
        <div class="form-grid">
          <label class="field">Email<input class="input" name="email" type="email" autocomplete="username" required></label>
          <label class="field">Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
          <div class="error-box ${message ? "" : "hidden"}" id="login-error">${esc(message)}</div>
          <button class="btn primary lg" id="login-btn">Sign in</button>
          ${IS_LOCAL_DEMO ? '<p class="muted small" style="margin:0">Local demo: <code>admin@demo.local</code> / <code>demo</code></p>' : ""}
        </div>
      </form>
    </div>`;
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email, password } = Object.fromEntries(new FormData(e.currentTarget));
    const btn = $("#login-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await backend.signIn(String(email).trim(), String(password));
      view.email = String(email).trim();
      showDashboard();
    } catch (err) {
      showLogin(friendlyError(err));
    }
  });
}

// ---------------------------------------------------------------- dashboard shell

async function showDashboard() {
  let settings;
  try {
    settings = await backend.getSettings();
  } catch (err) {
    return showLogin(friendlyError(err));
  }
  topRight.innerHTML = `
    <label class="toolbar small" title="Students can only start while the exam is open">
      <span class="switch"><input type="checkbox" id="open-toggle" ${settings.exam_open ? "checked" : ""}><span></span></span>
      <b id="open-label">${settings.exam_open ? "Exam OPEN" : "Exam closed"}</b>
    </label>
    <button class="btn danger sm" id="stop-all">Terminate all active</button>
    <span class="muted small">${esc(view.email)}</span>
    <button class="btn sm" id="logout">Sign out</button>`;

  $("#open-toggle").addEventListener("change", async (e) => {
    const open = e.target.checked;
    try {
      await backend.updateSettings({ exam_open: open });
      $("#open-label").textContent = open ? "Exam OPEN" : "Exam closed";
      toast(open ? "Exam opened — students can start now." : "Exam closed — no new attempts.", "success");
    } catch (err) {
      e.target.checked = !open;
      toast(friendlyError(err), "error");
    }
  });
  $("#stop-all").addEventListener("click", terminateAll);
  $("#logout").addEventListener("click", async () => {
    await backend.signOut();
    view.email = null;
    showLogin();
  });

  app.innerHTML = `
    <div style="padding:24px 0 60px;display:grid;gap:20px">
      <section class="kpis" id="kpis"></section>
      <div class="toolbar">
        <div class="tabs" id="tabs">
          <button class="tab" data-tab="attempts">Live & results</button>
          <button class="tab" data-tab="analytics">Question analytics</button>
          <button class="tab" data-tab="bank">Question bank</button>
          <button class="tab" data-tab="settings">Exam settings</button>
        </div>
        <span class="spacer"></span>
        <span class="muted small" id="refreshed"></span>
      </div>
      <section id="panel"></section>
    </div>`;
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) switchTab(b.dataset.tab);
  });
  switchTab(view.tab);
  startRefresh();
}

function switchTab(tab) {
  view.tab = tab;
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  const panel = $("#panel");
  panel.innerHTML = '<div class="card pad"><div class="spinner"></div></div>';
  if (tab === "attempts") renderAttemptsPanel();
  if (tab === "analytics") renderAnalytics();
  if (tab === "bank") renderBank();
  if (tab === "settings") renderSettings();
}

function startRefresh() {
  stopRefresh();
  refresh();
  view.refreshTimer = setInterval(refresh, REFRESH_MS);
}
function stopRefresh() {
  clearInterval(view.refreshTimer);
}

async function refresh() {
  try {
    view.attempts = await backend.listAttempts();
    renderKpis();
    if (view.tab === "attempts") renderAttemptRows();
    const r = $("#refreshed");
    if (r) r.textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    const r = $("#refreshed");
    if (r) r.textContent = `Refresh failed: ${friendlyError(err)}`;
    if (/JWT|not an exam admin|auth/i.test(err.message)) showLogin("Session expired — please sign in again.");
  }
}

const isOnline = (a) => a.status === "in_progress" && Date.now() - Date.parse(a.last_seen) < ONLINE_WINDOW_MS;

function renderKpis() {
  const box = $("#kpis");
  if (!box) return;
  const all = view.attempts;
  const active = all.filter((a) => a.status === "in_progress");
  const graded = all.filter((a) => a.percent !== null && a.status !== "in_progress");
  const avg = graded.length ? graded.reduce((s, a) => s + Number(a.percent), 0) / graded.length : 0;
  const best = graded.reduce((m, a) => Math.max(m, Number(a.percent)), 0);
  const kpi = (v, label) => `<div class="card kpi"><b>${v}</b><span>${label}</span></div>`;
  box.innerHTML = [
    kpi(`<span class="dot live"></span> ${active.filter(isOnline).length}`, "online right now"),
    kpi(active.length, "in progress"),
    kpi(all.filter((a) => a.status === "submitted").length, "submitted"),
    kpi(graded.length ? `${avg.toFixed(1)}%` : "—", "average score"),
    kpi(graded.length ? `${best}%` : "—", "best score"),
  ].join("");
}

// ---------------------------------------------------------------- attempts

function renderAttemptsPanel() {
  $("#panel").innerHTML = `
    <div class="card">
      <div class="toolbar pad" style="padding-bottom:12px">
        <input class="input" id="search" placeholder="Search name or ID…" style="max-width:260px" value="${esc(view.filter.q)}">
        <select class="input" id="status" style="max-width:200px">
          ${["all", "in_progress", "submitted", "terminated", "expired"].map((s) => `<option value="${s}" ${view.filter.status === s ? "selected" : ""}>${s === "all" ? "All statuses" : s.replace("_", " ")}</option>`).join("")}
        </select>
        <span class="spacer"></span>
        <button class="btn sm" id="csv">Export CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Student</th><th>Status</th><th>Progress</th><th>Score</th><th>Left tab</th><th>Started</th><th>Time used</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>`;
  $("#search").addEventListener("input", (e) => {
    view.filter = { ...view.filter, q: e.target.value };
    renderAttemptRows();
  });
  $("#status").addEventListener("change", (e) => {
    view.filter = { ...view.filter, status: e.target.value };
    renderAttemptRows();
  });
  $("#csv").addEventListener("click", exportCsv);
  $("#rows").addEventListener("click", onRowAction);
  renderAttemptRows();
}

function filteredAttempts() {
  const q = view.filter.q.trim().toLowerCase();
  return view.attempts.filter(
    (a) => (view.filter.status === "all" || a.status === view.filter.status) && (!q || a.student_name.toLowerCase().includes(q) || a.student_id.toLowerCase().includes(q))
  );
}

function renderAttemptRows() {
  const tbody = $("#rows");
  if (!tbody) return;
  const rows = filteredAttempts();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:32px">No attempts yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((a) => {
      const total = a.question_ids.length;
      const pct = Math.round((a.answered_count * 100) / total);
      const end = a.submitted_at ? Date.parse(a.submitted_at) : Date.now();
      return `<tr>
        <td><b>${esc(a.student_name)}</b><div class="muted small mono">${esc(a.student_id)}</div></td>
        <td><span class="pill st-${a.status}">${isOnline(a) ? '<span class="dot live"></span>' : ""}${a.status.replace("_", " ")}</span>
          ${a.terminated_reason ? `<div class="muted small">${esc(a.terminated_reason)}</div>` : ""}</td>
        <td><div class="mini-progress"><div class="progress"><div style="width:${pct}%"></div></div></div><span class="muted small">${a.answered_count}/${total}</span></td>
        <td>${a.percent === null ? "—" : `<b>${a.percent}%</b><div class="muted small">${a.score}/${a.max_score}</div>`}</td>
        <td>${a.tab_switches ? `<span class="pill ${a.tab_switches > 3 ? "st-terminated" : "st-expired"}">${a.tab_switches}×</span>` : '<span class="muted">0</span>'}</td>
        <td class="small">${fmtTime(a.started_at)}</td>
        <td class="small mono">${fmtDuration(end - Date.parse(a.started_at))}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" data-act="view" data-id="${a.id}">View</button>
          ${a.status === "in_progress" ? `<button class="btn sm danger" data-act="kill" data-id="${a.id}">Terminate</button>` : ""}
          <button class="btn sm ghost" data-act="del" data-id="${a.id}" title="Delete attempt (lets the student start again)">Reset</button>
        </td></tr>`;
    })
    .join("");
}

async function onRowAction(e) {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const a = view.attempts.find((x) => x.id === b.dataset.id);
  if (!a) return;
  if (b.dataset.act === "view") return showAttempt(a.id);
  if (b.dataset.act === "kill") {
    const reason = await askDialog({
      title: `Terminate ${a.student_name}'s exam?`,
      body: "Their exam ends immediately and the answers saved so far are graded. Reason shown to the student:",
      input: "Terminated by instructor",
      confirmLabel: "Terminate now",
      danger: true,
    });
    if (reason === false) return;
    try {
      await backend.terminate([a.id], reason.slice(0, 200));
      toast(`${a.student_name}'s exam was terminated.`, "success");
      refresh();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  }
  if (b.dataset.act === "del") {
    const sure = await askDialog({
      title: `Reset ${a.student_name}'s attempt?`,
      body: "The attempt and its score are deleted permanently, and the student can start the exam again.",
      confirmLabel: "Delete & allow retake",
      danger: true,
    });
    if (!sure) return;
    try {
      await backend.deleteAttempt(a.id);
      toast("Attempt deleted.", "success");
      refresh();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  }
}

async function terminateAll() {
  const active = view.attempts.filter((a) => a.status === "in_progress").length;
  if (!active) return toast("No active attempts.");
  const sure = await askDialog({
    title: `Terminate all ${active} active exam(s)?`,
    body: "Every running exam ends now and the saved answers are graded. Consider closing the exam too so nobody new can start.",
    confirmLabel: "Terminate everyone",
    danger: true,
  });
  if (!sure) return;
  try {
    const n = await backend.terminateAll("Exam stopped by instructor");
    toast(`${n} attempt(s) terminated.`, "success");
    refresh();
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

function exportCsv() {
  const cell = (v) => {
    const s = String(v ?? "");
    // neutralise spreadsheet formulas and quote everything
    const safe = /^[\t\r=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const header = ["name", "student_id", "status", "score", "max_score", "percent", "answered", "questions", "tab_switches", "started_at", "submitted_at", "terminated_reason"];
  const lines = filteredAttempts().map((a) =>
    [a.student_name, a.student_id, a.status, a.score, a.max_score, a.percent, a.answered_count, a.question_ids.length, a.tab_switches, a.started_at, a.submitted_at, a.terminated_reason].map(cell).join(",")
  );
  const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `exam-results-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function loadQuestions() {
  if (!view.questions) view.questions = await backend.listQuestions();
  return view.questions;
}

function fmtGiven(q, v) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return '<span class="muted">—</span>';
  if (q.type === "text") return `<code>${esc(Array.isArray(v) ? v.join(" | ") : v)}</code>`;
  return (Array.isArray(v) ? v : [v]).map((i) => `${"ABCDEF"[i]}. ${esc(q.options[i] ?? "?")}`).join("<br>");
}

async function showAttempt(id) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = '<div class="card modal wide"><div class="spinner"></div></div>';
  document.body.append(modal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.dataset.close) modal.remove();
  });
  try {
    const [a, qs] = await Promise.all([backend.getAttempt(id), loadQuestions()]);
    const byId = new Map(qs.map((q) => [q.id, q]));
    const res = new Map((a.results ?? []).map((r) => [r.id, r]));
    const items = a.question_ids.map((qid, i) => {
      const q = byId.get(qid);
      const r = res.get(qid);
      const given = r ? r.given : a.answers[qid];
      const mark = r ? (r.correct ? '<b class="tone-great">✓</b>' : '<b class="tone-bad">✗</b>') : '<span class="muted">…</span>';
      return `<tr><td class="mono">${i + 1}</td><td>${mark}</td>
        <td><span class="pill lvl-${q.difficulty}">${q.difficulty}</span><div class="muted small">S${q.session}</div></td>
        <td><details><summary>${richText(q.prompt.slice(0, 110))}${q.prompt.length > 110 ? "…" : ""}</summary>
          <div style="margin-top:8px">${richText(q.prompt)}${codeBlock(q.code)}</div></details></td>
        <td class="small">${fmtGiven(q, given)}</td>
        <td class="small">${r ? fmtGiven(q, r.answer) : '<span class="muted">after grading</span>'}</td></tr>`;
    });
    modal.firstElementChild.innerHTML = `
      <div class="toolbar"><h3 style="margin:0">${esc(a.student_name)} <span class="muted small mono">${esc(a.student_id)}</span></h3>
        <span class="spacer"></span><span class="pill st-${a.status}">${a.status.replace("_", " ")}</span>
        ${a.percent !== null ? `<b>${a.percent}% (${a.score}/${a.max_score})</b>` : ""}</div>
      <p class="muted small">Started ${fmtTime(a.started_at)} · deadline ${fmtTime(a.deadline)} · left tab ${a.tab_switches}× · ${esc(a.user_agent ?? "")}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th></th><th>Level</th><th>Question</th><th>Answer given</th><th>Correct answer</th></tr></thead>
      <tbody>${items.join("")}</tbody></table></div>
      <div class="modal-actions"><button class="btn" data-close="1">Close</button></div>`;
    highlightWithin(modal);
  } catch (err) {
    modal.firstElementChild.innerHTML = `<p class="error-box">${esc(friendlyError(err))}</p><div class="modal-actions"><button class="btn" data-close="1">Close</button></div>`;
  }
}

// ---------------------------------------------------------------- analytics

async function renderAnalytics() {
  try {
    const stats = await backend.questionStats();
    if (!stats.length) {
      $("#panel").innerHTML = '<div class="card pad muted">Analytics appear once students submit.</div>';
      return;
    }
    $("#panel").innerHTML = `
      <div class="card"><div class="pad" style="padding-bottom:0"><h3 style="margin:0">Hardest questions first</h3>
      <p class="muted small">Low success rates show topics to re-teach — or questions worth re-checking.</p></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>ID</th><th>Session</th><th>Level</th><th>Question</th><th>Seen</th><th>Correct</th></tr></thead><tbody>
      ${stats.map((s) => `<tr><td class="mono small">${esc(s.id)}</td><td class="small">S${s.session}</td><td><span class="pill lvl-${s.difficulty}">${s.difficulty}</span></td>
        <td class="small">${richText(s.prompt)}</td><td>${s.seen}</td>
        <td><div class="bar" style="width:100px;display:inline-block;vertical-align:middle"><div style="width:${s.rate}%;background:${s.rate < 40 ? "var(--bad)" : s.rate < 70 ? "var(--warn)" : "var(--ok)"}"></div></div> <b class="small">${s.rate}%</b></td></tr>`).join("")}
      </tbody></table></div></div>`;
  } catch (err) {
    $("#panel").innerHTML = `<div class="card pad error-box">${esc(friendlyError(err))}</div>`;
  }
}

// ---------------------------------------------------------------- bank

async function renderBank() {
  try {
    const qs = await loadQuestions();
    const counts = (key) => qs.reduce((m, q) => ({ ...m, [q[key]]: (m[q[key]] ?? 0) + 1 }), {});
    const lv = counts("difficulty");
    const bySession = counts("session");
    $("#panel").innerHTML = `
      <div class="card pad">
        <h3 style="margin-top:0">${qs.length} questions in the bank</h3>
        <div class="toolbar" style="margin-bottom:12px">${LEVELS.map((l) => `<span class="pill lvl-${l.key}">${l.label}: ${lv[l.key] ?? 0}</span>`).join("")}</div>
        <div class="check-grid">${Object.keys(SESSIONS).map((s) => `<div class="small" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px">S${s} · ${esc(SESSIONS[s])} <b style="float:right">${bySession[s] ?? 0}</b></div>`).join("")}</div>
        <p class="muted small">To edit questions, change <code>bank/sessions/*.json</code>, run <code>node tools/build.mjs</code>, and run the new <code>supabase/seed.sql</code>.</p>
      </div>`;
  } catch (err) {
    $("#panel").innerHTML = `<div class="card pad error-box">${esc(friendlyError(err))}</div>`;
  }
}

// ---------------------------------------------------------------- settings

async function renderSettings() {
  let s;
  let qs;
  let roster;
  try {
    [s, qs, roster] = await Promise.all([backend.getSettings(), loadQuestions(), backend.listRoster()]);
  } catch (err) {
    $("#panel").innerHTML = `<div class="card pad error-box">${esc(friendlyError(err))}</div>`;
    return;
  }
  const chosen = new Set(s.sessions);
  $("#panel").innerHTML = `
    <form class="card pad form-grid" id="settings-form" novalidate>
      <h3 style="margin:0">Exam settings</h3>
      <p class="muted small" style="margin:0">Changes apply to attempts started after you save. Running attempts keep their questions and deadline.</p>
      <label class="field">Exam title<input class="input" name="title" maxlength="120" value="${esc(s.title)}"></label>
      <div class="grid-2">
        <label class="field">Time limit (minutes)<input class="input" type="number" name="time_limit_minutes" min="1" max="600" value="${s.time_limit_minutes}"></label>
        <label class="field">Attempts allowed per student<input class="input" type="number" name="max_attempts" min="1" max="50" value="${s.max_attempts}"></label>
        <label class="field">Auto-terminate after leaving the tab (0 = never)<input class="input" type="number" name="max_tab_switches" min="0" max="100" value="${s.max_tab_switches}"></label>
        <label class="field">Access code (empty = none)<input class="input" name="access_code" maxlength="40" value="${esc(s.access_code)}" autocomplete="off"></label>
      </div>
      <div>
        <b class="small">Questions drawn per level</b> <span class="muted small" id="avail-note"></span>
        <div class="grid-2" style="grid-template-columns:repeat(4,1fr);margin-top:6px">
          ${LEVELS.map((l) => `<label class="field"><span class="pill lvl-${l.key}">${l.label} · ${l.points} pt</span>
            <input class="input" type="number" min="0" max="500" name="count_${l.key}" value="${Number(s.counts[l.key] ?? 0)}">
            <span class="muted small" data-avail="${l.key}"></span></label>`).join("")}
        </div>
      </div>
      <div>
        <div class="toolbar"><b class="small">Sessions included</b><span class="spacer"></span>
          <button type="button" class="btn sm" id="all-s">All</button><button type="button" class="btn sm" id="none-s">None</button></div>
        <div class="check-grid" style="margin-top:8px">${Object.keys(SESSIONS).map((n) => `<label><input type="checkbox" name="session" value="${n}" ${chosen.has(Number(n)) ? "checked" : ""}> S${n} · ${esc(SESSIONS[n])}</label>`).join("")}</div>
      </div>
      <label class="toolbar small"><span class="switch"><input type="checkbox" name="show_review" ${s.show_review ? "checked" : ""}><span></span></span>
        Show correct answers & explanations to students once you close the exam (scores show immediately)</label>
      <label class="field">Class list — allowed student IDs, one per line (empty = anyone with the link)
        <textarea class="input mono" name="roster" rows="6" placeholder="2024-117&#10;2024-200&#10;sara@mail.com">${esc(roster.join("\n"))}</textarea>
        <span class="muted small">${roster.length ? `${roster.length} students listed — only they can start.` : "Recommended: stops strangers or fake IDs from opening the exam."}</span></label>
      <div class="toolbar"><span class="spacer"></span><button class="btn primary" id="save-settings">Save settings</button></div>
    </form>`;

  const form = $("#settings-form");
  const updateAvail = () => {
    const sel = new Set([...form.querySelectorAll('input[name="session"]:checked')].map((c) => Number(c.value)));
    LEVELS.forEach((l) => {
      const n = qs.filter((q) => q.active !== false && q.difficulty === l.key && sel.has(q.session)).length;
      form.querySelector(`[data-avail="${l.key}"]`).textContent = `${n} available`;
    });
  };
  form.addEventListener("change", updateAvail);
  $("#all-s").addEventListener("click", () => {
    form.querySelectorAll('input[name="session"]').forEach((c) => (c.checked = true));
    updateAvail();
  });
  $("#none-s").addEventListener("click", () => {
    form.querySelectorAll('input[name="session"]').forEach((c) => (c.checked = false));
    updateAvail();
  });
  updateAvail();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const int = (k, min, max) => Math.min(max, Math.max(min, Math.round(Number(fd.get(k)) || 0)));
    const patch = {
      title: String(fd.get("title") ?? "").trim().slice(0, 120) || "Generative AI Exam",
      time_limit_minutes: int("time_limit_minutes", 1, 600),
      max_attempts: int("max_attempts", 1, 50),
      max_tab_switches: int("max_tab_switches", 0, 100),
      access_code: String(fd.get("access_code") ?? "").trim().slice(0, 40),
      counts: Object.fromEntries(LEVELS.map((l) => [l.key, int(`count_${l.key}`, 0, 500)])),
      sessions: fd.getAll("session").map(Number),
      show_review: fd.get("show_review") === "on",
    };
    if (!patch.sessions.length) return toast("Pick at least one session.", "error");
    if (!Object.values(patch.counts).some((n) => n > 0)) return toast("Draw at least one question.", "error");
    const ids = [...new Set(String(fd.get("roster") ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = ids.filter((x) => !/^[a-z0-9._@+-]{2,64}$/.test(x));
    if (bad.length) return toast(`Invalid student IDs in class list: ${bad.slice(0, 3).join(", ")}`, "error", 6000);
    try {
      await backend.updateSettings(patch);
      await backend.setRoster(ids);
      toast(`Settings saved${ids.length ? ` · ${ids.length} students on the class list` : ""}.`, "success");
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });
}

boot();
