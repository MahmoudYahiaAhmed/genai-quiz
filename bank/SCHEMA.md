# Question bank schema

One file per session: `bank/sessions/sNN.json` (NN = 00..25, `s00` = Orientation).
Each file is a JSON **array** of question objects:

```json
{
  "id": "s05-q03",
  "session": 5,
  "difficulty": "easy | medium | hard | extreme",
  "type": "single | multi | text",
  "topic": "asyncio.gather",
  "prompt": "Question text. Use `backticks` for inline code. Plain text only, no HTML, no markdown headings. Use \n for line breaks.",
  "code": "optional python snippet shown in a code block (omit or \"\" when none)",
  "options": ["A", "B", "C", "D"],
  "answer": 2,
  "explanation": "2-4 sentences teaching WHY the answer is right and why the tempting wrong option is wrong.",
  "shuffle": true,
  "group": "optional — questions with the same group are never drawn into the same attempt"
}
```

Rules
- `id`: `sNN-qMM`, unique, MM = 01.. in order.
- `type: "single"` → `options` has 4 entries (3–5 allowed), `answer` = 0-based index (integer).
- `type: "multi"` → `options` has 4–6 entries, `answer` = array of 0-based indices (≥2 correct). Prompt must say "Select ALL that apply."
- `type: "text"` → no `options`; `answer` = array of accepted strings. Grading lowercases, treats `"` as `'`, and removes ALL whitespace on both sides, so `[1, 2]` matches `[1,2]`. Use only for unambiguous short answers (a printed output, a number, a single keyword). Prompt must say exactly what format to type (e.g. "Type the exact output").
- `shuffle`: set `false` only when option order matters (e.g. "Both A and B"). Prefer never writing "All/None of the above".
- Options must be plausible distractors of similar length; no joke options.
- Code: Python 3.11+, Pydantic v2, current FastAPI, LangChain ≥0.3 (`langchain_core`, `langchain_openai`, LCEL `|`), LangGraph ≥0.2/1.x (`StateGraph`, `START`, `END`, `add_messages`). Keep snippets ≤ 25 lines. Indent with 4 spaces.
- Difficulty meaning:
  - easy: recall / definition.
  - medium: apply a concept, read a short snippet.
  - hard: predict output of non-trivial code, spot the bug, compare trade-offs.
  - extreme: multi-step reasoning, subtle edge cases, design decisions where only one answer survives careful analysis.
