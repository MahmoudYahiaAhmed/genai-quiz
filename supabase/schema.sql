-- =====================================================================
-- GenAI Exam — Supabase schema
-- Run once in Supabase → SQL Editor. Safe to re-run (idempotent).
-- Then run the generated supabase/seed.sql (questions + answer keys).
--
-- Security model
--   * Students are anonymous: they only ever call the RPC functions below.
--   * The answer key lives in `answer_keys`, which anon can never read.
--   * Grading happens inside Postgres (security definer), so the correct
--     answers never reach the browser before the attempt is submitted.
--   * The admin signs in with Supabase Auth; their email must be listed in
--     `admins`. RLS gives only that user access to attempts/settings.
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+).

-- ---------- tables ----------------------------------------------------

create table if not exists public.admins (
  email text primary key check (email = lower(email))
);

create table if not exists public.questions (
  id         text primary key,
  session    int  not null,
  difficulty text not null check (difficulty in ('easy','medium','hard','extreme')),
  type       text not null check (type in ('single','multi','text')),
  topic      text not null default '',
  prompt     text not null,
  code       text not null default '',
  options    jsonb not null default '[]'::jsonb,
  shuffle    boolean not null default true,
  points     int not null,
  grp        text not null default '',  -- questions sharing a group never appear in the same attempt
  active     boolean not null default true
);
alter table public.questions add column if not exists grp text not null default '';

create table if not exists public.answer_keys (
  question_id text primary key references public.questions(id) on delete cascade,
  answer      jsonb not null,
  explanation text not null default ''
);

create table if not exists public.settings (
  id                 int primary key default 1 check (id = 1),
  exam_open          boolean not null default false,
  title              text not null default 'Generative AI — Final Exam',
  sessions           int[] not null default array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25],
  counts             jsonb not null default '{"easy":18,"medium":20,"hard":15,"extreme":7}'::jsonb,
  time_limit_minutes int not null default 90 check (time_limit_minutes between 1 and 600),
  max_attempts       int not null default 1 check (max_attempts between 1 and 50),
  max_tab_switches   int not null default 0 check (max_tab_switches >= 0), -- 0 = unlimited
  show_review        boolean not null default true,
  access_code        text not null default '',                              -- '' = no code needed
  updated_at         timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.attempts (
  id                uuid primary key default gen_random_uuid(),
  token             uuid not null default gen_random_uuid(),
  student_name      text not null,
  student_id        text not null,
  status            text not null default 'in_progress'
                    check (status in ('in_progress','submitted','terminated','expired')),
  question_ids      text[] not null,
  answers           jsonb not null default '{}'::jsonb,
  answered_count    int not null default 0,
  tab_switches      int not null default 0,
  score             numeric,
  max_score         numeric,
  percent           numeric,
  results           jsonb,
  started_at        timestamptz not null default now(),
  deadline          timestamptz not null,
  last_seen         timestamptz not null default now(),
  submitted_at      timestamptz,
  terminated_reason text,
  user_agent        text
);
create index if not exists attempts_student_idx on public.attempts (lower(student_id));
create index if not exists attempts_started_idx on public.attempts (started_at);

-- Optional class list. Empty = anyone with the link (and access code) may start.
create table if not exists public.roster (
  student_id text primary key check (student_id = lower(student_id)),
  name       text not null default ''
);
create index if not exists attempts_status_idx  on public.attempts (status);

-- ---------- RLS ---------------------------------------------------------

alter table public.admins      enable row level security;
alter table public.questions   enable row level security;
alter table public.answer_keys enable row level security;
alter table public.settings    enable row level security;
alter table public.attempts    enable row level security;
alter table public.roster      enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  -- Bound to the signed-in user's id and a CONFIRMED email in auth.users, so a
  -- self-signed-up account with an unconfirmed matching email is never admin.
  select exists (
    select 1 from public.admins a
    join auth.users u on lower(u.email) = a.email
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;

drop policy if exists admin_all on public.admins;
drop policy if exists admin_all on public.questions;
drop policy if exists admin_all on public.answer_keys;
drop policy if exists admin_all on public.settings;
drop policy if exists admin_all on public.attempts;
create policy admin_all on public.admins      for select to authenticated using (public.is_admin());
create policy admin_all on public.questions   for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.answer_keys for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.settings    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.attempts    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.roster;
create policy admin_all on public.roster      for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- No policies for `anon` → students cannot read any table directly.

-- ---------- helpers -----------------------------------------------------

create or replace function public._norm_text(t text) returns text
language sql immutable as $$
  -- case-insensitive, whitespace-insensitive, and " equals '
  select replace(lower(regexp_replace(coalesce(t, ''), '\s+', '', 'g')), '"', '''');
$$;

create or replace function public._sorted_ints(j jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
  from (select distinct (x #>> '{}')::int as v
        from jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) x
        where (x #>> '{}') ~ '^\d+$') s;
$$;

create or replace function public._is_correct(q_type text, key jsonb, given jsonb) returns boolean
language plpgsql immutable as $$
begin
  if given is null or given = 'null'::jsonb then
    return false;
  end if;
  if q_type = 'single' then
    return (given #>> '{}') = (key #>> '{}');
  elsif q_type = 'multi' then
    return public._sorted_ints(given) = public._sorted_ints(key);
  elsif q_type = 'text' then
    return exists (
      select 1 from jsonb_array_elements_text(key) k
      where public._norm_text(k) = public._norm_text(given #>> '{}')
    );
  end if;
  return false;
end;
$$;

-- Question payload sent to students: never includes the answer.
create or replace function public._public_questions(ids text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'session', q.session, 'difficulty', q.difficulty,
           'type', q.type, 'topic', q.topic, 'prompt', q.prompt, 'code', q.code,
           'options', q.options, 'shuffle', q.shuffle, 'points', q.points)
         order by array_position(ids, q.id)), '[]'::jsonb)
  from public.questions q where q.id = any(ids);
$$;

-- Grades an attempt from its stored answers and closes it with `final_status`.
create or replace function public._grade_attempt(p_attempt uuid, final_status text, reason text default null)
returns public.attempts
language plpgsql security definer set search_path = public as $$
declare
  a public.attempts;
  v_score numeric := 0;
  v_max numeric := 0;
  v_results jsonb := '[]'::jsonb;
  r record;
  ok boolean;
begin
  select * into a from public.attempts where id = p_attempt for update;
  if not found or a.status <> 'in_progress' then
    return a;
  end if;

  for r in
    select q.id, q.type, q.points, q.session, q.difficulty, k.answer, k.explanation
    from unnest(a.question_ids) with ordinality as u(qid, ord)
    join public.questions q on q.id = u.qid
    join public.answer_keys k on k.question_id = q.id
    order by u.ord
  loop
    ok := public._is_correct(r.type, r.answer, a.answers -> r.id);
    v_max := v_max + r.points;
    if ok then v_score := v_score + r.points; end if;
    v_results := v_results || jsonb_build_object(
      'id', r.id, 'session', r.session, 'difficulty', r.difficulty,
      'points', r.points, 'correct', ok, 'given', a.answers -> r.id,
      'answer', r.answer, 'explanation', r.explanation);
  end loop;

  update public.attempts set
    status = final_status,
    score = v_score,
    max_score = v_max,
    percent = case when v_max > 0 then round(v_score * 100.0 / v_max, 1) else 0 end,
    results = v_results,
    submitted_at = now(),
    terminated_reason = reason
  where id = p_attempt
  returning * into a;
  return a;
end;
$$;

create or replace function public._answered_count(ans jsonb) returns int
language sql immutable as $$
  select count(*)::int from jsonb_each(coalesce(ans, '{}'::jsonb)) e
  where e.value is not null and e.value <> 'null'::jsonb
    and e.value <> '""'::jsonb and e.value <> '[]'::jsonb;
$$;

-- Per-group totals (by level or by session) without question ids, so they
-- reveal nothing about which individual answers were right.
create or replace function public._result_groups(results jsonb, field text) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object('got', got, 'max', mx, 'right', rt, 'total', tot)), '{}'::jsonb)
  from (
    select x->>field as k,
           sum(case when (x->>'correct')::boolean then (x->>'points')::int else 0 end) as got,
           sum((x->>'points')::int) as mx,
           sum(case when (x->>'correct')::boolean then 1 else 0 end) as rt,
           count(*) as tot
    from jsonb_array_elements(coalesce(results, '[]'::jsonb)) x
    group by x->>field
  ) g;
$$;

-- Result payload the student sees after the attempt closes. While the exam is
-- still OPEN only totals are returned: per-question answers/explanations would
-- let someone harvest the key with throwaway attempts and pass it on.
create or replace function public._student_result(a public.attempts) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'status', a.status,
    'score', a.score, 'max_score', a.max_score, 'percent', a.percent,
    'terminated_reason', a.terminated_reason,
    'submitted_at', a.submitted_at,
    'question_count', cardinality(a.question_ids),
    'levels', public._result_groups(a.results, 'difficulty'),
    'sessions', public._result_groups(a.results, 'session'),
    'review_state', case when not s.show_review then 'hidden'
                         when s.exam_open then 'locked' else 'open' end,
    'results', case when s.show_review and not s.exam_open then a.results else '[]'::jsonb end)
  from public.settings s where s.id = 1;
$$;

-- Closes the attempt if its time is over (2-minute grace for network lag).
create or replace function public._expire_if_due(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.attempts
             where id = p_attempt and status = 'in_progress'
               and now() > deadline + interval '2 minutes') then
    perform public._grade_attempt(p_attempt, 'expired', 'Time limit reached');
  end if;
end;
$$;

-- ---------- student RPCs ------------------------------------------------

create or replace function public.get_exam_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'exam_open', s.exam_open, 'title', s.title,
    'time_limit_minutes', s.time_limit_minutes,
    'question_count', (select coalesce(sum(value::int), 0) from jsonb_each_text(s.counts)),
    'needs_code', s.access_code <> '',
    'max_tab_switches', s.max_tab_switches)
  from public.settings s where s.id = 1;
$$;

create or replace function public.start_attempt(p_name text, p_student_id text, p_code text default '', p_user_agent text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  s public.settings;
  v_name text := btrim(coalesce(p_name, ''));
  v_sid  text := lower(btrim(coalesce(p_student_id, '')));
  v_ids  text[] := '{}';
  v_level text;
  v_n int;
  v_used int;
  a public.attempts;
begin
  select * into s from public.settings where id = 1;
  if not s.exam_open then
    raise exception 'The exam is closed right now.' using errcode = 'P0001';
  end if;
  if s.access_code <> '' and coalesce(p_code, '') <> s.access_code then
    raise exception 'Wrong access code.' using errcode = 'P0001';
  end if;
  v_name := btrim(regexp_replace(v_name, '[[:cntrl:]]', '', 'g'));
  if length(v_name) < 3 or length(v_name) > 80 then
    raise exception 'Please enter your full name (3–80 characters).' using errcode = 'P0001';
  end if;
  if v_sid !~ '^[a-z0-9._@+-]{2,64}$' then
    raise exception 'Student ID / email may only contain letters, digits and . _ @ + - (2–64 chars).' using errcode = 'P0001';
  end if;
  -- when the instructor uploaded a roster, only listed IDs may start
  if exists (select 1 from public.roster) and not exists (select 1 from public.roster where student_id = v_sid) then
    raise exception 'This student ID is not on the class list. Check it or ask your instructor.' using errcode = 'P0001';
  end if;
  -- global brake against scripted floods
  if (select count(*) from public.attempts where started_at > now() - interval '1 minute') >= 120 then
    raise exception 'Too many exams are starting right now — wait a few seconds and try again.' using errcode = 'P0001';
  end if;

  -- serialize starts for the same student so two tabs cannot both pass the checks
  perform pg_advisory_xact_lock(hashtext(v_sid));

  for a in select * from public.attempts where lower(student_id) = v_sid and status = 'in_progress' loop
    perform public._expire_if_due(a.id);
  end loop;
  if exists (select 1 from public.attempts where lower(student_id) = v_sid and status = 'in_progress') then
    raise exception 'You already have an exam in progress. Continue it on the device where you started, or ask your instructor to reset it.' using errcode = 'P0001';
  end if;
  -- every attempt counts (terminated too); the instructor's Reset deletes one to allow a retake
  select count(*) into v_used from public.attempts where lower(student_id) = v_sid;
  if v_used >= s.max_attempts then
    raise exception 'You have used all of your allowed attempts.' using errcode = 'P0001';
  end if;

  foreach v_level in array array['easy','medium','hard','extreme'] loop
    v_n := coalesce((s.counts ->> v_level)::int, 0);
    if v_n > 0 then
      v_ids := v_ids || array(
        select pick.id from (
          select distinct on (case when q.grp = '' then q.id else q.grp end) q.id
          from public.questions q
          where q.active and q.difficulty = v_level and q.session = any(s.sessions)
            and (q.grp = '' or q.grp not in (select p.grp from public.questions p where p.id = any(v_ids)))
          order by case when q.grp = '' then q.id else q.grp end, random()
        ) pick order by random() limit v_n);
    end if;
  end loop;
  if cardinality(v_ids) = 0 then
    raise exception 'No questions match the exam settings.' using errcode = 'P0001';
  end if;

  insert into public.attempts (student_name, student_id, question_ids, deadline, user_agent)
  values (v_name, v_sid, v_ids, now() + make_interval(mins => s.time_limit_minutes), left(coalesce(p_user_agent, ''), 300))
  returning * into a;

  return jsonb_build_object(
    'attempt_id', a.id, 'token', a.token, 'deadline', a.deadline,
    'server_now', now(), 'title', s.title,
    'student_name', a.student_name, 'student_id', a.student_id,
    'max_tab_switches', s.max_tab_switches,
    'questions', public._public_questions(a.question_ids),
    'answers', a.answers);
end;
$$;

create or replace function public.resume_attempt(p_attempt uuid, p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a public.attempts; s public.settings;
begin
  perform public._expire_if_due(p_attempt);
  select * into a from public.attempts where id = p_attempt and token = p_token;
  if not found then
    raise exception 'Attempt not found.' using errcode = 'P0001';
  end if;
  select * into s from public.settings where id = 1;
  if a.status <> 'in_progress' then
    return jsonb_build_object('status', a.status, 'result', public._student_result(a));
  end if;
  return jsonb_build_object(
    'status', a.status, 'attempt_id', a.id, 'token', a.token, 'deadline', a.deadline,
    'server_now', now(), 'title', s.title,
    'student_name', a.student_name, 'student_id', a.student_id,
    'max_tab_switches', s.max_tab_switches,
    'tab_switches', a.tab_switches,
    'questions', public._public_questions(a.question_ids),
    'answers', a.answers);
end;
$$;

-- Called every few seconds: saves progress, reports focus loss, and tells the
-- client whether the instructor terminated the attempt.
create or replace function public.heartbeat(p_attempt uuid, p_token uuid, p_answers jsonb, p_tab_switches int)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a public.attempts; s public.settings;
begin
  if octet_length(coalesce(p_answers, '{}'::jsonb)::text) > 50000 then
    raise exception 'Answers too large.' using errcode = 'P0001';
  end if;
  select * into a from public.attempts where id = p_attempt and token = p_token;
  if not found then
    raise exception 'Attempt not found.' using errcode = 'P0001';
  end if;
  if a.status = 'in_progress' then
    select * into s from public.settings where id = 1;
    update public.attempts set
      answers = case when jsonb_typeof(p_answers) = 'object' and now() <= deadline
                     then (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                           from jsonb_each(p_answers) e(k, v) where k = any(question_ids))
                     else answers end,
      tab_switches = greatest(tab_switches, coalesce(p_tab_switches, 0)),
      last_seen = now()
    where id = p_attempt
    returning * into a;
    update public.attempts set answered_count = public._answered_count(answers) where id = p_attempt;
    if s.max_tab_switches > 0 and a.tab_switches > s.max_tab_switches then
      a := public._grade_attempt(p_attempt, 'terminated', 'Left the exam window too many times');
    else
      perform public._expire_if_due(p_attempt);
      select * into a from public.attempts where id = p_attempt;
    end if;
  end if;
  if a.status = 'in_progress' then
    return jsonb_build_object('status', a.status, 'server_now', now(), 'deadline', a.deadline);
  end if;
  return jsonb_build_object('status', a.status, 'result', public._student_result(a));
end;
$$;

create or replace function public.submit_attempt(p_attempt uuid, p_token uuid, p_answers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a public.attempts;
begin
  perform public.heartbeat(p_attempt, p_token, p_answers, null);
  select * into a from public.attempts where id = p_attempt and token = p_token;
  if a.status = 'in_progress' then
    a := public._grade_attempt(p_attempt, 'submitted');
  end if;
  return public._student_result(a);
end;
$$;

-- ---------- admin RPCs --------------------------------------------------

create or replace function public.admin_terminate(p_ids uuid[], p_reason text default 'Terminated by instructor')
returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid; n int := 0;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  for v_id in select id from public.attempts where id = any(p_ids) and status = 'in_progress' loop
    perform public._grade_attempt(v_id, 'terminated', left(coalesce(p_reason, ''), 200));
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.admin_terminate_all(p_reason text default 'Exam stopped by instructor')
returns int
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  return public.admin_terminate(array(select id from public.attempts where status = 'in_progress'), p_reason);
end;
$$;

-- Adds minutes to running attempts. p_ids = null → every attempt in progress.
-- Students' timers pick up the new deadline on their next heartbeat.
create or replace function public.admin_extend_time(p_ids uuid[], p_minutes int)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 600 then
    raise exception 'Extra time must be between 1 and 600 minutes.' using errcode = 'P0001';
  end if;
  update public.attempts
  set deadline = greatest(deadline, now()) + make_interval(mins => p_minutes)
  where status = 'in_progress' and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_question_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(row_to_json(t) order by t.rate nulls last), '[]'::jsonb) from (
      select x->>'id' as id, q.session, q.difficulty, q.topic, left(q.prompt, 140) as prompt,
             count(*) as seen,
             sum(case when (x->>'correct')::boolean then 1 else 0 end) as correct,
             round(avg(case when (x->>'correct')::boolean then 100.0 else 0 end), 1) as rate
      from public.attempts a
      cross join lateral jsonb_array_elements(a.results) x
      join public.questions q on q.id = x->>'id'
      where a.results is not null
      group by x->>'id', q.session, q.difficulty, q.topic, q.prompt
    ) t);
end;
$$;

-- ---------- grants ------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default; strip that from everything
-- and re-grant only the student RPCs (anon) and admin RPCs (authenticated).

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.get_exam_info()                         to anon, authenticated;
grant execute on function public.start_attempt(text, text, text, text)   to anon, authenticated;
grant execute on function public.resume_attempt(uuid, uuid)              to anon, authenticated;
grant execute on function public.heartbeat(uuid, uuid, jsonb, int)       to anon, authenticated;
grant execute on function public.submit_attempt(uuid, uuid, jsonb)       to anon, authenticated;
grant execute on function public.is_admin()                              to authenticated; -- used by RLS policies
grant execute on function public.admin_terminate(uuid[], text)           to authenticated;
grant execute on function public.admin_terminate_all(text)               to authenticated;
grant execute on function public.admin_extend_time(uuid[], int)          to authenticated;
grant execute on function public.admin_question_stats()                  to authenticated;
