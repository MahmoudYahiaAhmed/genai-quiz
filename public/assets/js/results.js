// Results screen: score ring, level/session breakdown, and a learning review.
import { LEVELS, LEVEL_BY_KEY, SESSIONS, esc, richText, codeBlock, highlightWithin, gradeLabel } from "./shared.js";

const LETTERS = "ABCDEF";

function ring(percent, tone) {
  const r = 88;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, percent)) / 100);
  return `
    <div class="ring">
      <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="14"/>
        <circle cx="100" cy="100" r="${r}" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"
          class="tone-${tone}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="ring-label"><div><b>${percent}%</b><span class="muted small">score</span></div></div>
    </div>`;
}


function barRow(label, s, color) {
  const pct = s.max ? Math.round((s.got * 100) / s.max) : 0;
  return `<div class="bar-row">
    <div>${label}</div>
    <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
    <div class="mono small" title="${s.right}/${s.total} questions">${pct}%</div>
  </div>`;
}

function formatAnswer(q, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "<em class='muted'>No answer</em>";
  if (q.type === "text") return `<code>${esc(Array.isArray(value) ? value[0] : value)}</code>`;
  const idx = Array.isArray(value) ? value : [value];
  return idx.map((i) => esc(q.options[i] ?? `#${i}`)).join(" · ");
}

function reviewItem(q, r, n) {
  const given = r.given;
  let body = "";
  if (q.type === "text") {
    body = `
      <div class="review-opt ${r.correct ? "correct" : "chosen-wrong"}"><b>Your answer:</b>&nbsp;${formatAnswer(q, given)}</div>
      ${r.correct ? "" : `<div class="review-opt correct"><b>Accepted:</b>&nbsp;${r.answer.map((a) => `<code>${esc(a)}</code>`).join(" or ")}</div>`}`;
  } else {
    const keySet = new Set(Array.isArray(r.answer) ? r.answer : [r.answer]);
    const givenSet = new Set(Array.isArray(given) ? given : given === null || given === undefined ? [] : [given]);
    body = `<div class="options">${q.options
      .map((opt, i) => {
        const cls = keySet.has(i) ? "correct" : givenSet.has(i) ? "chosen-wrong" : "";
        const tag = keySet.has(i) ? "✓" : givenSet.has(i) ? "✗" : LETTERS[i];
        const mine = givenSet.has(i) ? ' <span class="muted small">(your choice)</span>' : "";
        return `<div class="review-opt ${cls}"><b class="mono">${tag}</b><span>${richText(opt)}${mine}</span></div>`;
      })
      .join("")}</div>`;
  }
  return `
    <article class="card review-item ${r.correct ? "right" : "wrong"}" data-correct="${r.correct}">
      <div class="q-meta">
        <span class="q-number">Q${n}</span>
        <span class="pill lvl-${q.difficulty}">${LEVEL_BY_KEY[q.difficulty].label} · ${q.points} pt${q.points > 1 ? "s" : ""}</span>
        <span class="pill neutral">S${q.session} · ${esc(SESSIONS[q.session] ?? "")}</span>
        <span class="spacer"></span>
        <b class="${r.correct ? "tone-great" : "tone-bad"}">${r.correct ? "Correct" : "Incorrect"}</b>
      </div>
      <div class="q-prompt" style="font-size:16px">${richText(q.prompt)}</div>
      ${codeBlock(q.code)}
      ${body}
      ${r.explanation ? `<div class="explain"><b>Why:</b> ${richText(r.explanation)}</div>` : ""}
    </article>`;
}

function reviewSection(result, results, qById, right) {
  if (result.review_state === "hidden") return `<p class="muted">Detailed review is turned off by your instructor.</p>`;
  if (result.review_state === "locked" || !results.length) {
    return `<section class="card pad" style="display:grid;gap:10px;justify-items:start">
      <h2 style="margin:0">Review & learn — unlocks soon</h2>
      <p class="muted" style="margin:0">To keep the exam fair, the correct answers and explanations for every question unlock as soon as your instructor closes the exam. Keep this page (or come back on this device) and press the button.</p>
      <button class="btn primary" id="check-review">Check if the review is open</button>
    </section>`;
  }
  return `
    <section style="display:grid;gap:14px">
      <div class="toolbar">
        <h2 style="margin:0">Review & learn</h2><span class="spacer"></span>
        <div class="tabs" id="review-tabs">
          <button class="tab active" data-f="all">All (${results.length})</button>
          <button class="tab" data-f="false">Incorrect (${results.length - right})</button>
          <button class="tab" data-f="true">Correct (${right})</button>
        </div>
      </div>
      <div id="review-list" style="display:grid;gap:14px">
        ${results.map((r, i) => (qById.has(r.id) ? reviewItem(qById.get(r.id), r, i + 1) : "")).join("")}
      </div>
    </section>`;
}

/**
 * @param {HTMLElement} root
 * @param {{status:string, score:number, max_score:number, percent:number, terminated_reason?:string,
 *   question_count:number, levels:Object, sessions:Object, review_state:"open"|"locked"|"hidden", results:Array}} result
 * @param {Array} questions  public question objects from the attempt (may be empty after a cleared cache)
 * @param {{name?:string, onCheckReview?:() => void}} opts
 */
export function renderResults(root, result, questions, opts = {}) {
  const percent = Number(result.percent ?? 0);
  const grade = gradeLabel(percent);
  const results = result.results ?? [];
  const qById = new Map(questions.map((q) => [q.id, q]));
  const byLevel = new Map(Object.entries(result.levels ?? {}));
  const bySession = Object.entries(result.sessions ?? {})
    .map(([s, v]) => ({ s: Number(s), v, pct: v.max ? v.got / v.max : 0 }))
    .sort((a, b) => a.pct - b.pct);
  const weak = bySession.filter((x) => x.pct < 0.6).slice(0, 4);
  const right = [...byLevel.values()].reduce((n, v) => n + v.right, 0);
  const total = result.question_count ?? [...byLevel.values()].reduce((n, v) => n + v.total, 0);
  const who = { name: opts.name };

  const statusNote = {
    terminated: `<div class="notice">Your exam was ended early: ${esc(result.terminated_reason || "terminated by the instructor")}. Only the answers saved before that moment were graded.</div>`,
    expired: `<div class="notice">Time ran out — your saved answers were submitted automatically.</div>`,
  }[result.status] ?? "";


  root.innerHTML = `
    <div style="padding:28px 0 60px;display:grid;gap:20px">
      ${statusNote}
      <section class="card results-head">
        ${ring(percent, grade.tone)}
        <div>
          <div class="eyebrow">${who.name ? `${esc(who.name.split(" ")[0])}'s result` : "Your result"}</div>
          <h1 style="margin:6px 0 4px;font-size:34px;letter-spacing:-0.03em" class="tone-${grade.tone}">${grade.label}</h1>
          <p class="muted" style="margin:0 0 16px">You scored <b>${result.score} / ${result.max_score}</b> points and answered <b>${right} of ${total}</b> questions correctly. Harder levels are worth more points.</p>
          ${LEVELS.filter((l) => byLevel.has(l.key)).map((l) => barRow(`<span class="pill lvl-${l.key}">${l.label}</span>`, byLevel.get(l.key), `var(--${l.key})`)).join("")}
        </div>
      </section>

      <section class="grid-2">
        <div class="card pad">
          <h3 style="margin-top:0">Score by session</h3>
          <div style="max-height:360px;overflow:auto">${bySession.map((x) => barRow(`<span class="small">S${x.s} · ${esc(SESSIONS[x.s] ?? "")}</span>`, x.v, "var(--accent)")).join("")}</div>
        </div>
        <div class="card pad">
          <h3 style="margin-top:0">What to revisit next</h3>
          ${weak.length
            ? `<ol class="rules">${weak.map((x) => `<li><b>Session ${x.s} — ${esc(SESSIONS[x.s] ?? "")}</b>: ${x.v.right}/${x.v.total} correct. Re-read the notes and redo the session lab.</li>`).join("")}</ol>`
            : `<p class="muted">No weak spots below 60% — great consistency. Push yourself with the Extreme questions in the review below.</p>`}
          <p class="muted small" style="margin-top:16px">Tip: read every explanation below, even for questions you got right — the "why" is where the learning happens.</p>
        </div>
      </section>

      ${reviewSection(result, results, qById, right)}
    </div>`;

  highlightWithin(root);
  root.querySelector("#check-review")?.addEventListener("click", () => opts.onCheckReview?.());
  const tabs = root.querySelector("#review-tabs");
  tabs?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
    root.querySelectorAll(".review-item").forEach((item) => {
      item.classList.toggle("hidden", btn.dataset.f !== "all" && item.dataset.correct !== btn.dataset.f);
    });
  });
}
