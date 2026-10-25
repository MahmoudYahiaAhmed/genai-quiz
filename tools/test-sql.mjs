// Runs supabase/schema.sql + seed.sql in an in-memory Postgres (PGlite) and checks
// security, grading, termination, expiry and question drawing. Usage: npm test
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bank = JSON.parse(readFileSync(`${ROOT}/bank/build/questions.json`, "utf8"));
const key = new Map(bank.map((q) => [q.id, q]));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); };
async function expectErr(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (no error)`); } catch (e) { ok(re.test(e.message), `${msg} → ${e.message}`); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

// Supabase stand-ins
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  insert into auth.users values
    ('00000000-0000-0000-0000-000000000001', 'Teacher@School.org', now()),
    ('00000000-0000-0000-0000-000000000002', 'random@x.com', now()),
    ('00000000-0000-0000-0000-000000000003', 'teacher@school.org', null); -- unconfirmed impostor
  grant execute on function auth.jwt() to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`);
await db.exec(readFileSync(`${ROOT}/supabase/schema.sql`, "utf8"));
await db.exec(readFileSync(`${ROOT}/supabase/schema.sql`, "utf8")); // idempotent
await db.exec(readFileSync(`${ROOT}/supabase/seed.sql`, "utf8"));
ok((await one("select count(*)::int n from questions")).n === bank.length, "seed loaded all questions");
await db.exec(`insert into admins values ('teacher@school.org')`);

const asAnon = async (sql, params) => {
  await db.exec(`set role anon; select set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  try { return await one(sql, params); } finally { await db.exec("reset role"); }
};
const USERS = { "teacher@school.org": 1, "Teacher@School.org": 1, "random@x.com": 2, impostor: 3 };
const asUser = async (who, sql, params) => {
  const claims = { sub: `00000000-0000-0000-0000-00000000000${USERS[who]}`, email: who === "impostor" ? "teacher@school.org" : who };
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false);`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
};

// --- anon isolation
ok((await asAnon("select count(*)::int n from answer_keys")).n === 0, "anon sees no answer keys");
ok((await asAnon("select count(*)::int n from questions")).n === 0, "anon cannot list questions table");
await expectErr(() => asAnon("select public._grade_attempt(gen_random_uuid(), 'submitted')"), /permission denied/, "anon cannot call _grade_attempt");
await expectErr(() => asAnon("select public.admin_terminate_all('x')"), /permission denied|Not authorized/, "anon cannot terminate");

// --- closed exam
await expectErr(() => asAnon("select start_attempt('Sara Ahmed','s1')"), /closed/, "start blocked while closed");
await db.exec("update settings set exam_open = true, counts = '{\"easy\":3,\"medium\":3,\"hard\":2,\"extreme\":2}', max_attempts = 1");
const info = (await asAnon("select get_exam_info() j")).j;
ok(info.exam_open && info.question_count === 10, "exam info reflects settings");

// --- validation
await expectErr(() => asAnon("select start_attempt('Al','s1')"), /full name/, "short name rejected");
await expectErr(() => asAnon("select start_attempt('Sara Ahmed','bad id!')"), /Student ID/, "bad student id rejected");

// --- start
const start = (await asAnon("select start_attempt('Sara Ahmed','S1@x.com','', 'test-agent') j")).j;
ok(start.questions.length === 10, "10 questions drawn");
ok(start.questions.every((q) => !("answer" in q) && !("explanation" in q)), "no answers leaked in payload");
const order = start.questions.map((q) => q.difficulty).join(",");
ok(order === "easy,easy,easy,medium,medium,medium,hard,hard,extreme,extreme", "ordered by level");
await expectErr(() => asAnon("select start_attempt('Sara Ahmed','s1@x.com')"), /in progress/, "second concurrent attempt blocked (case-insensitive id)");

// --- heartbeat: answer half correctly, one wrong
const ids = start.questions.map((q) => q.id);
const answers = {};
ids.forEach((id, i) => {
  const q = key.get(id);
  if (i % 2 === 0) answers[id] = q.type === "text" ? `  ${q.answer[0].toUpperCase()} ` : q.answer; // correct (text with case/space noise)
  else if (i === 1) answers[id] = q.type === "text" ? "nope" : q.type === "multi" ? [q.answer[0]] : (q.answer + 1) % q.options.length;
});
answers["not-in-attempt"] = 1;
const hb = (await asAnon("select heartbeat($1,$2,$3,2) j", [start.attempt_id, start.token, answers])).j;
ok(hb.status === "in_progress", "heartbeat ok");
await expectErr(() => asAnon("select heartbeat($1,gen_random_uuid(),'{}',0)", [start.attempt_id]), /not found/, "wrong token rejected");
const row = await one("select answers, answered_count, tab_switches from attempts where id = $1", [start.attempt_id]);
ok(!("not-in-attempt" in row.answers) && row.answered_count === 6 && row.tab_switches === 2, `stored answers filtered (answered=${row.answered_count})`);

// --- submit
const res = (await asAnon("select submit_attempt($1,$2,$3) j", [start.attempt_id, start.token, answers])).j;
const expected = ids.filter((_, i) => i % 2 === 0).reduce((s, id) => s + key.get(id).points, 0);
const max = ids.reduce((s, id) => s + key.get(id).points, 0);
ok(res.status === "submitted" && Number(res.score) === expected && Number(res.max_score) === max, `graded ${res.score}/${res.max_score} (expected ${expected}/${max})`);
ok(res.review_state === "locked" && res.results.length === 0, "no per-question review while the exam is open");
ok(res.levels.easy.total === 3 && Object.values(res.sessions).every((g) => !("id" in g)), "only level/session totals while open");
await db.exec("update settings set exam_open = false");
const unlocked = (await asAnon("select resume_attempt($1,$2) j", [start.attempt_id, start.token])).j.result;
ok(unlocked.review_state === "open" && unlocked.results.length === 10 && unlocked.results[0].explanation, "full review unlocks after the exam closes");
ok(unlocked.questions.length === 10 && unlocked.questions.every((q) => q.prompt && !("answer" in q)), "unlocked review carries question text (no answer field)");
ok(res.questions.length === 0, "no question text in the result while the exam is open");
await db.exec("update settings set exam_open = true");
const res2 = (await asAnon("select submit_attempt($1,$2,'{}') j", [start.attempt_id, start.token])).j;
ok(Number(res2.score) === expected, "re-submit does not change the grade");
await expectErr(() => asAnon("select start_attempt('Sara Ahmed','s1@x.com')"), /all of your allowed attempts/, "max attempts enforced");

// --- show_review off hides answers
await db.exec("update settings set show_review = false");
const hidden = (await asAnon("select resume_attempt($1,$2) j", [start.attempt_id, start.token])).j;
ok(hidden.result.review_state === "hidden" && hidden.result.results.length === 0, "review hidden when show_review=false");
await db.exec("update settings set show_review = true");

// --- admin terminate
const b = (await asAnon("select start_attempt('Omar Khaled','s2') j")).j;
const c = (await asAnon("select start_attempt('Lina Samir','s3') j")).j;
await expectErr(() => asUser("random@x.com", "select admin_terminate(array[$1::uuid],'x')", [b.attempt_id]), /Not authorized/, "non-admin user cannot terminate");
ok((await asUser("random@x.com", "select count(*)::int n from attempts")).rows[0].n === 0, "non-admin user sees no attempts");
ok((await asUser("teacher@school.org", "select count(*)::int n from attempts")).rows[0].n === 3, "admin sees all attempts");
ok((await asUser("impostor", "select count(*)::int n from attempts")).rows[0].n === 0, "unconfirmed account with the admin email is NOT admin");
const n = (await asUser("Teacher@School.org", "select admin_terminate(array[$1::uuid],'Cheating') n", [b.attempt_id])).rows[0].n;
ok(n === 1, "admin terminated one attempt (email case-insensitive)");
const hbB = (await asAnon("select heartbeat($1,$2,'{}',0) j", [b.attempt_id, b.token])).j;
ok(hbB.status === "terminated" && hbB.result.terminated_reason === "Cheating", "student heartbeat sees termination");
ok((await asUser("teacher@school.org", "select admin_terminate_all() n")).rows[0].n === 1, "terminate all closed the remaining one");
ok((await asAnon("select heartbeat($1,$2,'{}',0) j", [c.attempt_id, c.token])).j.status === "terminated", "second student sees termination");
const stats = (await asUser("teacher@school.org", "select admin_question_stats() j")).rows[0].j;
ok(Array.isArray(stats) && stats.length > 0, `question stats (${stats.length} rows)`);
await asUser("teacher@school.org", "update settings set title = 'New title' where id = 1");
ok((await one("select title from settings")).title === "New title", "admin can update settings");
await asUser("random@x.com", "update settings set exam_open = false where id = 1");
ok((await one("select exam_open from settings")).exam_open === true, "non-admin cannot update settings");

// --- terminated attempts still count; admin Reset (delete) allows a retake
await expectErr(() => asAnon("select start_attempt('Omar Khaled','s2')"), /allowed attempts/, "terminated student cannot simply restart");
await asUser("teacher@school.org", "delete from attempts where id = $1", [b.attempt_id]);
const retake = (await asAnon("select start_attempt('Omar Khaled','s2') j")).j;
ok(!!retake.attempt_id, "after admin reset the student can retake");

// --- tab-switch limit
await db.exec("update settings set max_tab_switches = 3");
const t = (await asAnon("select heartbeat($1,$2,'{}',4) j", [retake.attempt_id, retake.token])).j;
ok(t.status === "terminated" && /too many/.test(t.result.terminated_reason), "auto-terminated after too many tab switches");
await db.exec("update settings set max_tab_switches = 0");

// --- expiry
const e = (await asAnon("select start_attempt('Mona Adel','s4') j")).j;
await db.query("update attempts set deadline = now() - interval '10 minutes' where id = $1", [e.attempt_id]);
const late = (await asAnon("select heartbeat($1,$2,$3,0) j", [e.attempt_id, e.token, { [e.questions[0].id]: 0 }])).j;
ok(late.status === "expired", "expired attempt auto-closed");
ok((await one("select answered_count from attempts where id=$1", [e.attempt_id])).answered_count === 0, "answers after deadline ignored");

// --- access code
await db.exec("update settings set access_code = 'GENAI25'");
await expectErr(() => asAnon("select start_attempt('Yara Nabil','s5','wrong')"), /access code/, "wrong access code rejected");
ok(!!(await asAnon("select start_attempt('Yara Nabil','s5','GENAI25') j")).j.attempt_id, "correct access code accepted");

// --- grading rules on every question in the bank
let gradeOk = 0;
for (const q of bank) {
  const r = (await one("select public._is_correct($1,$2,$3) a, public._is_correct($1,$2,$4) b", [
    q.type, JSON.stringify(q.answer),
    JSON.stringify(q.type === "text" ? q.answer[0] : q.type === "multi" ? [...q.answer].reverse() : q.answer),
    JSON.stringify(q.type === "text" ? "zzz-wrong" : q.type === "multi" ? q.answer.slice(1) : (q.answer + 1) % q.options.length),
  ]));
  if (r.a === true && r.b === false) gradeOk++; else console.log("grading mismatch", q.id, r);
}
ok(gradeOk === bank.length, `grader accepts key & rejects wrong answer for all ${bank.length} questions`);

// --- roster
await db.exec("insert into roster values ('stu-1','A'),('stu-2','B')");
await expectErr(() => asAnon("select start_attempt('Not Listed','stranger','GENAI25')"), /class list/, "roster blocks unknown IDs");
ok(!!(await asAnon("select start_attempt('Listed One','STU-1','GENAI25') j")).j.attempt_id, "roster allows listed IDs");
ok((await asAnon("select count(*)::int n from roster")).n === 0, "anon cannot read the roster");
await db.exec("delete from roster");

// --- abuse limits
await expectErr(() => asAnon("select heartbeat($1,$2,$3,0)", [e.attempt_id, e.token, { x: "y".repeat(60000) }]), /too large/, "oversized answers rejected");
await expectErr(() => asAnon("select public._is_correct('single','1','1')"), /permission denied/, "helper functions not callable by anon");
const nm = (await asAnon("select start_attempt(E'\t=HYPERLINK(1)','ctrl-1','GENAI25') j")).j.student_name;
ok(nm === "=HYPERLINK(1)", "control characters stripped from names");

// --- extend time
{
  const x = (await asAnon("select start_attempt('Time Tester','time-1','GENAI25') j")).j;
  const y = (await asAnon("select start_attempt('Time Tester Two','time-2','GENAI25') j")).j;
  const before = Date.parse(x.deadline);
  await expectErr(() => asUser("random@x.com", "select admin_extend_time(array[$1::uuid], 30)", [x.attempt_id]), /Not authorized/, "non-admin cannot extend time");
  await expectErr(() => asUser("teacher@school.org", "select admin_extend_time(array[$1::uuid], 0)", [x.attempt_id]), /between 1 and 600/, "invalid extra minutes rejected");
  ok((await asUser("teacher@school.org", "select admin_extend_time(array[$1::uuid], 30) n", [x.attempt_id])).rows[0].n === 1, "admin extended one attempt");
  const hbx = (await asAnon("select heartbeat($1,$2,'{}',0) j", [x.attempt_id, x.token])).j;
  ok(Math.round((Date.parse(hbx.deadline) - before) / 60000) === 30, "heartbeat returns deadline +30 min");
  const yBefore = Date.parse((await one("select deadline from attempts where id=$1", [y.attempt_id])).deadline);
  const all = (await asUser("teacher@school.org", "select admin_extend_time(null, 15) n")).rows[0].n;
  const yAfter = Date.parse((await one("select deadline from attempts where id=$1", [y.attempt_id])).deadline);
  ok(all >= 2 && Math.round((yAfter - yBefore) / 60000) === 15, `extend all added 15 min to every running attempt (${all})`);
  // a student just past the deadline (inside the grace window) gets the time counted from now
  await db.query("update attempts set deadline = now() - interval '1 minute' where id = $1", [y.attempt_id]);
  await asUser("teacher@school.org", "select admin_extend_time(array[$1::uuid], 10)", [y.attempt_id]);
  const qid = y.questions[0].id;
  const hby = (await asAnon("select heartbeat($1,$2,$3,0) j", [y.attempt_id, y.token, { [qid]: 0 }])).j;
  const left = (Date.parse(hby.deadline) - Date.now()) / 60000;
  ok(hby.status === "in_progress" && left > 9 && left <= 10.1, "late student gets the extra time from now and keeps going");
  ok((await one("select answered_count from attempts where id=$1", [y.attempt_id])).answered_count === 1, "answers accepted again after extension");
  const done = (await one("select count(*)::int n from attempts where status <> 'in_progress'")).n;
  await asUser("teacher@school.org", "select admin_extend_time(null, 5)");
  ok((await one("select count(*)::int n from attempts where status <> 'in_progress'")).n === done, "finished attempts are not reopened");
}

// --- pairs never drawn together, even when drawing the whole bank
await db.exec(`update settings set access_code = '', max_attempts = 50, counts = '{"easy":99,"medium":99,"hard":99,"extreme":99}'`);
let clash = 0;
const sizes = new Set();
for (let i = 0; i < 15; i++) {
  const x = (await asAnon(`select start_attempt('Pair Tester','pair${i}') j`)).j;
  const groups = x.questions.map((q) => key.get(q.id).group).filter(Boolean);
  if (new Set(groups).size !== groups.length) clash++;
  sizes.add(x.questions.length);
}
ok(clash === 0 && [...sizes].every((n) => n === bank.length - 7), `no paired questions together (${[...sizes]} of ${bank.length} drawn)`);
ok((await one(`select public._is_correct('text', $1::jsonb, $2::jsonb) a`, [JSON.stringify(["('41', 3)"]), JSON.stringify('("41",3)')])).a === true, "double vs single quotes graded equal");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
