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

// Suggested by the audit. A post is dropped when Jev rates it below these.
const THRESHOLDS = {
  vacancy: 0.6,     // `post` is a real, open job / internship
  studentFit: 0.5,  // realistic for a student or fresh graduate
  kazakhstan: 0.5,  // in Kazakhstan, or remote and open to Kazakhstan
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
  studentFit:
    'The opening in `post` is realistic for a university student or fresh graduate without prior full-time experience: an internship, trainee or junior role, part-time or shift work, or it says no experience is required.',
  kzRelevant:
    'The opening in `post` is located in Kazakhstan, or is remote and open to applicants living in Kazakhstan.',
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

module.exports = { THRESHOLDS, MAX_POST_CHARS, MAX_CANDIDATES, CONCURRENCY, MAX_CONSECUTIVE_FAILURES, NOUL, CHOICE, NONE };
