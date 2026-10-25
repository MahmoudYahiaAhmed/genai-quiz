# Generative AI Final Exam

An exam website for the course (Orientation + Sessions 1–25), hosted for free on **GitHub Pages**. Scores and live control run on **Supabase** (free tier).

- **180 questions** (52 easy · 52 medium · 51 hard · 25 extreme) covering every session: code-output prediction, bug spotting, numeric reasoning (attention shapes, cosine similarity, chunk counts, GPU memory), LangGraph state traces, and design trade-offs.
- Three question types: single choice, multiple choice ("select all"), and typed answers.
- Each student gets a **random exam** made of 4 levels in order: Easy → Medium → Hard → Extreme. Harder levels are worth more points (1 / 2 / 3 / 5).
- Students see a **timer**, a **question navigator**, **flags**, keyboard shortcuts and autosave. If they reload, they continue where they were.
- After submitting, students see their **score** right away, plus a breakdown by level and by session and a **"what to revisit"** list.
- When you **close the exam**, a full review with the correct answer and an **explanation for every question** unlocks for students. Keeping it locked while the exam is open stops anyone from collecting the answers and passing them to classmates who are still working.
- **Only you** can sign in to the control room (`/admin.html`). There you can:
  - watch who is online and how far each student has got
  - **terminate** one student or everyone
  - open or close the exam
  - reset an attempt so the student can retake it
  - export results to CSV
  - see which questions students miss most
  - change the exam settings
- Cheating protection:
  - Answers are graded **inside the database**. The answer key never reaches the browser before submission.
  - The timer is enforced by the server.
  - Leaving the exam tab is counted, and you can set a limit that ends the exam automatically.
  - You can require an access code and upload a **class list** of allowed student IDs.
  - New exam starts are rate-limited.
  - Each student gets a different random set of questions with shuffled options. Questions that would give each other away are never put in the same exam.

```
public/            ← the website (only this folder is published)
  index.html       student exam
  admin.html       instructor control room
  config.js        your Supabase URL + anon key
supabase/
  schema.sql       tables, security rules, grading functions (safe to publish)
  seed.sql         GENERATED — questions + ANSWER KEY (git-ignored)
bank/sessions/     the question bank, one JSON file per session (git-ignored)
tools/build.mjs    validates the bank and generates seed.sql
tools/test-sql.mjs 50 automated tests of the database logic
```

---

## Setup (about 15 minutes, one time)

### 1. Create the Supabase project
1. Go to <https://supabase.com>, create a free account, and create a **New project**.
2. Open **SQL Editor → New query**. Paste all of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. On your computer, in this folder, run `node tools/build.mjs`. This creates `supabase/seed.sql`. Paste that file into a new SQL query and **Run** it. This loads the 180 questions and their answers.
4. Create your admin login:
   - **Authentication → Users → Add user → Create new user**. Enter your email and a strong password, and tick *Auto Confirm User*.
   - In the SQL Editor, run (with your email in lowercase):
     ```sql
     insert into public.admins (email) values ('your.email@example.com');
     ```
5. Turn off public sign-ups: **Authentication → Sign In / Providers → Email**, then switch off **Allow new users to sign up**. Students never need an account.

### 2. Connect the website
In Supabase, open **Project Settings → API** and copy the **Project URL** and the **anon public** key into [`public/config.js`](public/config.js):

```js
window.QUIZ_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

The anon key is meant to be public. The database security rules decide what it can do: students can only start, save and submit their own attempt.

### 3. Publish with GitHub Pages
1. Create a GitHub repository and push this folder to the `main` branch. `.gitignore` keeps the answer key out of the repo.
2. In the repo, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` deploys the `public/` folder on every push. You will get a link like:
   - Students: `https://<your-user>.github.io/<repo>/`
   - You: `https://<your-user>.github.io/<repo>/admin.html`

---

## On exam day
1. Open `admin.html` and sign in. In **Exam settings**, choose the sessions, how many questions per level and the time limit. Optionally set an access code.
   - **Recommended:** paste your class list of student IDs, one per line. Only those IDs can start, so nobody can sit the exam under a fake ID or block a classmate by using their ID.
   - The default is 60 questions (18 easy, 20 medium, 15 hard, 7 extreme) in 90 minutes.
   - To use the whole bank, set each level to 99.
2. Share the student link and switch on **Exam OPEN**. A student's landing page refreshes by itself, so they can open it early and wait.
3. Watch the live table. Use **Terminate** on one student, or **Terminate all active** for everyone. A student whose exam you end sees it within about 10 seconds, and the answers they saved so far are graded.
4. Close the exam when you are done. This also **unlocks the review** for students: they press *Check if the review is open* on their result page, on the same device. Then use **Export CSV** and **Question analytics**.

**Retakes:** each student gets *Attempts allowed* tries (default 1), and a terminated attempt counts as one. Use **Reset** on a row to delete that attempt and let the student start again.

## Editing questions
1. Edit `bank/sessions/sNN.json`. The format is in [`bank/SCHEMA.md`](bank/SCHEMA.md).
2. Run `npm test`. This validates the bank and runs the database tests (run `npm i` once first).
3. Paste the new `supabase/seed.sql` into the Supabase SQL Editor. It updates questions in place, and questions you delete stop being drawn.

## Try it locally without Supabase
Leave `config.js` empty, run `node tools/build.mjs` and then `npm run serve`. Open <http://127.0.0.1:5500/public/>. Demo mode keeps everything in your browser, and the control room login is `admin@demo.local` / `demo`. This only works on your machine.

## Keep the answer key private
GitHub Pages only publishes `public/`, but a **public repository** shows every committed file. That is why `bank/sessions/` and `seed.sql` are git-ignored. Back them up somewhere private, such as a private repo or a drive.
