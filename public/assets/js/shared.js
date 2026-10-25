// Shared helpers for the student and admin pages.

export const SESSIONS = {
  0: "Orientation",
  1: "Generative AI revision on AI",
  2: "GenAI tools & practical revision",
  3: "Unsupervised & semi-supervised",
  4: "Generative AI concepts",
  5: "Venv & Async",
  6: "Async, Pydantic, FastAPI, Dataclasses",
  7: "Pydantic & Dataclasses practice",
  8: "FastAPI — all sides",
  9: "FastAPI auth & multiple APIs",
  10: "Transformers — the beginning",
  11: "SLM vs LLM",
  12: "Hugging Face exploration",
  13: "BERT & GPT",
  14: "Encoder–Decoder, Cond/Variational AE",
  15: "Generative model parts & Stable Diffusion",
  16: "Prompt engineering",
  17: "Embeddings",
  18: "Embeddings practical, Vector DB & RAG",
  19: "Chunking for RAG",
  20: "Completing the mini RAG",
  21: "LangChain",
  22: "LangChain: vector stores & prompting",
  23: "LangChain final",
  24: "LangGraph",
  25: "LangGraph continued",
};

export const LEVELS = [
  { key: "easy", label: "Easy", stage: 1, points: 1 },
  { key: "medium", label: "Medium", stage: 2, points: 2 },
  { key: "hard", label: "Hard", stage: 3, points: 3 },
  { key: "extreme", label: "Extreme", stage: 4, points: 5 },
];
export const LEVEL_BY_KEY = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

export const sessionLabel = (n) => `Session ${n === 0 ? "0" : n} · ${SESSIONS[n] ?? "Unknown"}`;

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Escapes everything, then turns `inline code` into <code> and newlines into <br>.
export function richText(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

export function codeBlock(code, lang = "python") {
  if (!code) return "";
  return `<pre class="code"><code class="language-${lang}">${esc(code)}</code></pre>`;
}

export function highlightWithin(root) {
  if (!window.hljs) return;
  root.querySelectorAll("pre.code code").forEach((el) => window.hljs.highlightElement(el));
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(message, kind = "info", ms = 3500) {
  let box = document.getElementById("toast");
  if (!box) {
    box = el('<div id="toast" role="status" aria-live="polite"></div>');
    document.body.append(box);
  }
  box.className = `toast show ${kind}`;
  box.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), ms);
}

/**
 * Styled confirm dialog. Resolves to false when cancelled, true when confirmed,
 * or the typed text when `input` is given.
 * @param {{title:string, body?:string, input?:string, confirmLabel?:string, danger?:boolean}} opts
 * @returns {Promise<boolean|string>}
 */
export function askDialog({ title, body = "", input, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const modal = el(`<div class="modal-backdrop"><form class="card modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${body ? `<p class="muted">${esc(body)}</p>` : ""}
        ${input !== undefined ? `<input class="input" name="value" maxlength="200" value="${esc(input)}">` : ""}
        <div class="modal-actions">
          <button type="button" class="btn" data-cancel="1">Cancel</button>
          <button type="submit" class="btn ${danger ? "danger" : "primary"}">${esc(confirmLabel)}</button>
        </div></form></div>`);
    const close = (value) => {
      modal.remove();
      resolve(value);
    };
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.dataset.cancel) close(false);
    });
    modal.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      close(input !== undefined ? modal.querySelector("input").value.trim() || input : true);
    });
    document.body.append(modal);
    (modal.querySelector("input") ?? modal.querySelector("button[type=submit]")).focus();
  });
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Deterministic PRNG so an attempt keeps the same option order after a reload.
export function seededShuffle(items, seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function gradeLabel(percent) {
  if (percent >= 90) return { label: "Outstanding", tone: "great" };
  if (percent >= 75) return { label: "Strong", tone: "good" };
  if (percent >= 60) return { label: "Passed", tone: "ok" };
  if (percent >= 40) return { label: "Needs review", tone: "warn" };
  return { label: "Keep practicing", tone: "bad" };
}

export function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Network problem — check your connection and try again.";
  return msg.replace(/^.*?ERROR:\s*/i, "");
}
