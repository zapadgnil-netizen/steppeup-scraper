/**
 * telegram/judge-config.js — everything you would tune about the Jev (TypeSafe)
 * judgments lives in THIS file: the thresholds and the question wording.
 *
 * Jev answers typed questions (noul = probability of yes, choice = one of the
 * options we list) about the `state` we send. It cannot browse or write text, so
 * code extracts candidates (apply targets, title lines, employer names) and Jev
 * only CHOOSES between them. The wording below is adapted from the audit run on
 * 441 real posts (/Users/nadyr/jev/src/questions.ts `tgPostQuestions`).
 *
 * If TYPESAFE_API_KEY is unset, the SDK is missing, or a call fails, the scraper
 * finishes on rules alone and says so (see jev.js and the per-run stats).
 */

// HOW A JEV ANSWER BECOMES A KEEP/DROP (see decideVerdict in jev.js).
//
// A noul answer is the probability of "yes". Two lines per question:
//   CONFIDENT_NO  - below this Jev is very sure the post fails: drop it, whatever
//                   the rules think.
//   SOFT          - between CONFIDENT_NO and SOFT Jev leans "no" but is not sure.
//                   That alone never cuts a post the rules have a positive signal
//                   for (student/part-time/shift/project wording, a student job
//                   channel, a Kazakhstan city). Without such a signal it drops.
// Evidence (live run over the current posts of 5 channels, see the commit
// message): posts that really are unsuitable (gender/age limit, "опыт от 3 лет",
// senior) scored 0.03-0.08; suitable shift/service/project posts the old wording
// scored 0.14-0.37 are what this band protects.
const SOFT = {
  vacancy: 0.4,      // `post` is a real, open job / internship
  studentFit: 0.3,   // a student or fresh graduate could be considered
  kazakhstan: 0.4,   // in Kazakhstan, or remote and open to Kazakhstan
};
const CONFIDENT_NO = { vacancy: 0.15, studentFit: 0.15, kazakhstan: 0.15 };
// Re-judge of a row that is ALREADY live: only a score this low (and the rules
// also rejecting) may retire it. Never a single verdict near a threshold.
const DEACTIVATE_BELOW = 0.1;
// Re-judge circuit breaker: wanting to retire more than this share of the active
// Telegram rows in one run means the questions are off, not the board.
const MAX_DEACTIVATE_RATIO = 0.15;
const MIN_DEACTIVATE_ALLOWED = 2; // tiny boards: a couple of retirements is normal
// Compact per-post reasons kept in the run stats (scraping_logs.details).
const MAX_DECISIONS_LOGGED = 100;
// Kept for callers that read the old shape; the soft lines above are the thresholds.
const THRESHOLDS = SOFT;

// Who reads each kind of channel - Jev sees this next to the post.
const CHANNEL_AUDIENCE = {
  career: 'a student job / career-centre channel: its readers are university students and young specialists, and nearly every post is meant for them',
  university: 'an official university channel: news and events plus occasional jobs, read by that university\'s students',
  general: 'a general city job board for the public in Almaty: most posts are ordinary jobs and only some suit students (shift, service, retail and part-time work often do)',
};

// Post text sent to Jev (≈1,500–2,000 input tokens per post at this cap).
const MAX_POST_CHARS = 3000;
// Candidate lists are capped so the prompt stays small.
const MAX_CANDIDATES = 8;
// Posts judged in parallel per batch.
const CONCURRENCY = 6;
// After this many failed calls in a row the run stops asking and uses rules.
const MAX_CONSECUTIVE_FAILURES = 3;

const NOUL = {
  isVacancy:
    '`post` advertises one or more specific open jobs, internships or trainee programs that a reader can apply to now. It is not an event or webinar invitation, a course, a news item, a survey, an ad for a product or service, a job seeker\'s resume, or channel self-promotion.',
  // Object form = { instructions, criteria: { true, false } } (noul accepts both).
  studentFit: {
    instructions:
      'Could a university student or recent graduate reasonably apply for the opening in `post` and be considered? `channel_audience` says who normally reads the channel. Assume yes unless the post clearly rules students out.',
    criteria: {
      true:
        'Suitable: internships, trainee, junior, assistant and entry-level roles; part-time, shift and service work (waiter, courier, cashier, barista, cook, sales consultant, warehouse picker, administrator); project-based, freelance and remote work; creative and digital roles (SMM, design, content, video, UGC); a post that lists skills, tools or a portfolio or says experience is desirable or a plus but does not set a minimum number of years.',
      false:
        'Clearly not suitable: the post sets a minimum number of years of experience (for example "от 3 лет"), requires a completed degree or a professional licence, is a senior, lead or managerial level, says students are not wanted, or is limited to one gender or an age range.',
    },
  },
  kzRelevant:
    'The opening in `post` is located in Kazakhstan, or is remote and open to applicants living in Kazakhstan. A post that names no country but sits in a Kazakhstani channel, names a Kazakhstani city or pays in tenge counts as Kazakhstan.',
};

const CHOICE = {
  applyTarget:
    'Which entry in `candidates` is the place a candidate should go to, or the contact they should write or call, in order to apply for the opening in `post`? Ignore links to the channel itself, to other channels, to resume boards, to ads, and to the employer\'s general home page when a more specific application link or contact is listed.',
  titleLine:
    'Which entry in `title_candidates` is the name of the ROLE being hired for in `post` (for example "Стажёр в отдел маркетинга"), not a condition, a department, a sentence or a slogan?',
  employer:
    'Which entry in `employer_candidates` is the name of the EMPLOYER hiring in `post`, not the channel, a recruiter, a job board or a description of the industry?',
};

const NONE = {
  applyTarget: 'None of the listed candidates is where to apply, or the post is not a job opening',
  titleLine: 'None of the listed lines names the role',
  employer: 'The post does not name the employer',
};

module.exports = { THRESHOLDS, SOFT, CONFIDENT_NO, DEACTIVATE_BELOW, MAX_DEACTIVATE_RATIO, MIN_DEACTIVATE_ALLOWED, MAX_DECISIONS_LOGGED, CHANNEL_AUDIENCE, MAX_POST_CHARS, MAX_CANDIDATES, CONCURRENCY, MAX_CONSECUTIVE_FAILURES, NOUL, CHOICE, NONE };
