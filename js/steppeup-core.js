/**
 * SteppeUp shared listing/match helpers.
 * Loaded in the browser as a classic script (global SteppeUpCore) and required
 * from Node tests / the scraper. Keep this file free of DOM and i18n.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SteppeUpCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WORD = '[A-Za-z0-9А-Яа-яЁёӘәІіҢңҒғҮүҰұҚқӨөҺһ]';
  var BROWSE_PAGE_SIZE = 24;
  var SEEN_ID_CAP = 10000;
  var FEED_WINDOW = 500;
  var KNOWN_FLAGS = ['internship', 'part-time', 'remote', 'no-exp', 'flexible', 'paid-intern', 'has-salary', 'telegram'];
  var SITE_ORIGIN = 'https://steppeup.ai';
  var EMPLOYER_EMAIL = 'vp@nopac.net';
  var TELEGRAM_FEED_LIMIT = 150;

  var MAJOR_SKILL_MAP = {
    'информат':  ['javascript', 'python', 'java', 'c++', 'sql', 'react', 'node'],
    'программ':  ['javascript', 'python', 'java', 'c++', 'sql', 'react', 'node'],
    'it':        ['javascript', 'python', 'java', 'sql', 'react', 'docker', 'linux'],
    'маркетинг': ['smm', 'canva', 'excel', 'копирайтинг', 'seo', 'аналитика'],
    'финанс':    ['excel', '1c', 'sql', 'финансы', 'python', 'аналитика'],
    'дизайн':    ['figma', 'ux research', 'прототипирование', 'canva'],
    'менеджмент': ['hr', 'excel', 'коммуникации', '1c'],
    'экономик':  ['excel', '1c', 'финансы', 'sql', 'python']
  };

  var DEFAULT_INTEREST_KEYWORDS = {
    it: ['разраб', 'developer', 'devops', 'qa', 'тестиров', 'frontend', 'backend', 'python', 'javascript', 'kotlin'],
    marketing: ['маркетинг', 'smm', 'контент', 'content', 'copywr', 'seo'],
    design: ['дизайн', 'ux', 'ui', 'figma', 'design'],
    finance: ['финанс', 'аналитик', 'банк', 'бухгалтер', '1c', 'excel', 'finance'],
    hr: ['hr', 'рекрутинг', 'кадр', 'персонал'],
    analytics: ['аналитик', 'analyst', 'data', 'данн', 'sql', 'excel', 'python'],
    sales: ['продаж', 'sales'],
    law: ['юрист', 'legal', 'law', 'право']
  };

  var FIELD_STEMS = {
    'разраб': true, 'тестиров': true, 'аналитик': true, 'финанс': true,
    'продаж': true, 'маркетинг': true, 'дизайн': true, 'контент': true,
    'рекрутинг': true, 'кадр': true, 'персонал': true, 'copywr': true,
    'данн': true, 'юрист': true, 'бухгалтер': true, 'разработ': true
  };

  var SKILL_ALIASES = {
    javascript: ['javascript', 'js', 'джаваскрипт'],
    java: ['java', 'джава'],
    python: ['python', 'питон', 'пайтон'],
    typescript: ['typescript', 'ts'],
    sql: ['sql'],
    nosql: ['nosql'],
    react: ['react'],
    'react native': ['react native', 'react-native'],
    nodejs: ['node', 'node.js', 'nodejs', 'node js'],
    excel: ['excel', 'эксель', 'эксел']
  };

  var ALIAS_TO_CANON = {};
  Object.keys(SKILL_ALIASES).forEach(function (canon) {
    SKILL_ALIASES[canon].forEach(function (alias) {
      ALIAS_TO_CANON[alias] = canon;
    });
    ALIAS_TO_CANON[canon] = canon;
  });

  var CAREER_ADVICE_TITLE = /hr[-\s]?инсайд|что реально думают рекрутер|карьерн\w+\s+консульт|как\s+найти\s+работу|поиск\s+работы\s+без|карьерный\s+гид|поможем\s+с\s+резюме|резюме\s+(?:за|под)\s+\d/i;
  var EVENT_TITLE_INTENT = /^(?:гостев\w*\s+)?(?:лекци|вебинар|мастер-?класс|митап|meetup|воркшоп|семинар|конференци|форум|хакатон|грант|стипенди|ярмарка\s+вакансий|день\s+открытых)|(?:вебинар|лекци[яи]|конференци[яи]|форум|хакатон|грант)\s*[:—–-]/i;
  var HIRING_TITLE = /стажировк|стажер|стажёр|intern|trainee|ваканси|junior|джуниор|тағылымдама|engineer|разработчик|developer|программист|менеджер|analyst|аналитик|designer|дизайнер|маркетолог|бухгалтер|рекрутер|помощник|ассистент/i;

  function asArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value == null || value === '') return [];
    return String(value).split('|').map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function unique(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (item) {
      var key = String(item);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(item);
    });
    return out;
  }

  function normalizeSkill(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function canonicalizeSkill(value) {
    var n = normalizeSkill(value);
    return ALIAS_TO_CANON[n] || n;
  }

  function isFieldStem(value) {
    var n = normalizeSkill(value);
    return !!(n && FIELD_STEMS[n]);
  }

  function tokenBoundaryRegex(token) {
    var t = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (t === 'java') return new RegExp('(?<!' + WORD + ')java(?!script)(?!' + WORD + ')', 'i');
    if (t === 'js') return new RegExp('(?<!' + WORD + ')js(?!' + WORD + ')', 'i');
    if (t === 'it') return new RegExp('(?<!' + WORD + ')it(?!' + WORD + ')', 'i');
    if (t === 'sql') return new RegExp('(?<!no)(?<!' + WORD + ')sql(?!' + WORD + ')', 'i');
    if (t === 'react') return new RegExp('(?<!' + WORD + ')react(?![\\s-]*native)(?!' + WORD + ')', 'i');
    return new RegExp('(?<!' + WORD + ')' + t + '(?!' + WORD + ')', 'i');
  }

  function stemInText(stem, text) {
    var hay = String(text || '');
    var n = normalizeSkill(stem);
    if (!hay || !n || n === 'it' || n.length < 3) return false;
    var t = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<!' + WORD + ')' + t, 'i').test(hay);
  }

  function skillInText(skill, text) {
    var hay = String(text || '');
    if (!hay || !skill) return false;
    var norm = normalizeSkill(skill);
    if (!norm) return false;
    if (isFieldStem(norm)) return stemInText(norm, hay);
    var canon = canonicalizeSkill(norm);
    var aliases = SKILL_ALIASES[canon] || [norm];
    for (var i = 0; i < aliases.length; i++) {
      if (tokenBoundaryRegex(aliases[i]).test(hay)) return true;
    }
    return tokenBoundaryRegex(norm).test(hay);
  }

  function skillsAlign(userSkill, jobSkill) {
    var a = canonicalizeSkill(userSkill);
    var b = canonicalizeSkill(jobSkill);
    if (!a || !b) return false;
    if (a === 'it' || b === 'it') return a === b;
    return a === b;
  }

  function profileSignals(profile) {
    var p = profile && typeof profile === 'object' ? profile : {};
    var skills = Array.isArray(p.skills) ? p.skills.filter(function (s) { return String(s).trim(); }) : [];
    var interests = Array.isArray(p.interests) ? p.interests.filter(function (s) { return String(s).trim(); }) : [];
    var major = typeof p.major === 'string' ? p.major.trim() : '';
    var city = typeof p.city === 'string' ? p.city.trim() : '';
    var name = typeof p.name === 'string' ? p.name.trim() : '';
    return { skills: skills, interests: interests, major: major, city: city, name: name };
  }

  /**
   * Personal percentages need skill/interest/major evidence.
   * A city or a name alone is not a skills fit.
   */
  function hasMatchableProfile(profile) {
    var s = profileSignals(profile);
    return s.skills.length > 0 || s.interests.length > 0 || !!s.major;
  }

  function profilePromptKind(profile) {
    if (hasMatchableProfile(profile)) return null;
    var s = profileSignals(profile);
    if (s.city && !s.skills.length && !s.interests.length && !s.major) return 'city-only';
    if (s.name && !s.city) return 'name-only';
    return 'guest';
  }

  function emptyMatch() {
    return {
      score: null,
      reasons: [],
      hits: { skills: [], field: [], city: false },
      components: { skill: 0, field: 0, city: 0 }
    };
  }

  function displayableScore(result) {
    if (!result || result.score == null) return null;
    var n = Number(result.score);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }

  function jobBlob(job) {
    return [
      (job && job.title) || '',
      (job && job.company) || '',
      (job && job.description) || '',
      Array.isArray(job && job.tags) ? job.tags.join(' ') : ''
    ].join(' ');
  }

  function calcMatch(job, profile, options) {
    var opts = options || {};
    if (!job || !hasMatchableProfile(profile)) return emptyMatch();

    var signals = profileSignals(profile);
    var jobSkills = Array.isArray(job.skills) ? job.skills : [];
    var jobText = jobBlob(job);
    var reasons = [];
    var skillHits = [];
    var skillScore = 0;

    if (signals.skills.length) {
      var directHits = 0;
      var textHits = 0;
      signals.skills.forEach(function (us) {
        var direct = jobSkills.some(function (js) { return skillsAlign(us, js); });
        if (direct) {
          directHits += 1;
          skillHits.push(us);
        } else if (normalizeSkill(us).length >= 3 && skillInText(us, jobText)) {
          textHits += 1;
          skillHits.push(us);
        }
      });
      skillScore = Math.min(50, directHits * 16 + textHits * 6);
      unique(skillHits).slice(0, 2).forEach(function (sk) {
        reasons.push(sk);
      });
    }

    var fieldScore = 0;
    var fieldHits = [];
    if (signals.major) {
      var majorLow = signals.major.toLowerCase();
      var majorMap = opts.majorSkillMap || MAJOR_SKILL_MAP;
      Object.keys(majorMap).forEach(function (majorKw) {
        if (fieldScore >= 12) return;
        if (majorKw.length <= 2) {
          if (!tokenBoundaryRegex(majorKw).test(signals.major)) return;
        } else if (majorLow.indexOf(majorKw) === -1) return;
        var related = majorMap[majorKw] || [];
        if (related.some(function (rs) {
          return jobSkills.some(function (js) { return skillsAlign(rs, js); }) || skillInText(rs, jobText);
        })) {
          fieldScore += 12;
          fieldHits.push(signals.major);
        }
      });
    }
    if (signals.interests.length) {
      var ikMap = opts.interestKeywords || {};
      signals.interests.forEach(function (interest) {
        if (fieldScore >= 25) return;
        var kws = ikMap[interest] || DEFAULT_INTEREST_KEYWORDS[normalizeSkill(interest)] || [];
        if (kws.some(function (kw) {
          return isFieldStem(kw) ? stemInText(kw, jobText) : skillInText(kw, jobText);
        })) {
          fieldScore += 13;
          fieldHits.push(interest);
        }
      });
    }
    fieldScore = Math.min(25, fieldScore);
    unique(fieldHits).slice(0, 1).forEach(function (item) { reasons.push(item); });

    var cityScore = 0;
    var cityHit = false;
    if (signals.city && job.city && signals.city === job.city) {
      cityScore = 15;
      cityHit = true;
      reasons.push(job.city);
    } else if (signals.city && job.remote) {
      cityScore = 8;
      cityHit = true;
      reasons.push('remote');
    }

    // Location alone is not a fit: without any skill or field/interest evidence
    // the city bonus must not turn an unrelated job into a "15% match".
    var raw = (skillScore + fieldScore > 0) ? skillScore + fieldScore + cityScore : 0;
    if (raw <= 0) {
      return {
        score: null,
        reasons: [],
        hits: { skills: [], field: [], city: false },
        components: { skill: skillScore, field: fieldScore, city: cityScore }
      };
    }

    return {
      score: Math.min(100, raw),
      reasons: reasons.slice(0, 3),
      hits: { skills: unique(skillHits), field: unique(fieldHits), city: cityHit },
      components: { skill: skillScore, field: fieldScore, city: cityScore }
    };
  }

  function stableIdRank(id) {
    var h = 0;
    var str = String(id == null ? '' : id);
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function parseTime(value) {
    if (!value) return 0;
    var n = Date.parse(value);
    return isNaN(n) ? 0 : n;
  }

  function publicationDate(job) {
    var posted = job && job.posted_at;
    var provenance = job && (job.date_source || job.posted_at_source || job.dateProvenance);
    var checked = (job && (job.checked_at || job.last_checked_at)) || null;
    var source = String((job && job.source) || '').toLowerCase();
    if (provenance === 'ingestion' || provenance === 'scrape' || (job && job.posted_at_is_ingest)) {
      return { iso: null, kind: 'ingestion', checkedIso: checked };
    }
    var postedMs = parseTime(posted);
    if (!postedMs) {
      return { iso: null, kind: 'unknown', checkedIso: checked };
    }
    var boardDate = provenance === 'published' || provenance === 'source' ||
      /^(hh|enbek)/.test(source);
    if (!boardDate && /telegram|community|user/.test(source)) {
      return { iso: null, kind: 'unverified', checkedIso: checked };
    }
    return { iso: posted, kind: 'published', checkedIso: checked };
  }

  // Calendar day (Almaty, UTC+5) of a job's publication date. enbek.kz stamps
  // posts at midnight while hh.kz carries exact times; comparing whole days
  // stops the exact timestamp from always ranking hh above enbek.
  var DAY_MS = 86400000;
  var ALMATY_OFFSET_MS = 5 * 3600000;
  function recencyDay(job) {
    var ms = parseTime(publicationDate(job).iso);
    return ms ? Math.floor((ms + ALMATY_OFFSET_MS) / DAY_MS) : 0;
  }

  function guestSortKey(job) {
    var boost = 0;
    if (job && job.type === 'internship') boost += 3;
    if (job && job.internshipUncertain) boost -= 2;
    if (job && (job.noExp || job.seniority === 'junior')) boost += 2;
    if (job && job.salary && job.salary !== '—' && !job.salaryUncertain) boost += 1;
    if (job && job.remote) boost += 1;
    var pub = publicationDate(job);
    var recency = recencyDay(job);
    return { boost: boost, recency: recency, idRank: stableIdRank(job && job.id) };
  }

  // A job is Featured only while featured_until lies in the future. The column
  // may be absent entirely (older databases): that is the same as "not featured".
  function isFeatured(job, now) {
    var until = parseTime(job && job.featured_until);
    if (!until) return false;
    return until > (typeof now === 'number' ? now : Date.now());
  }

  function compareJobs(a, b, mode, now) {
    var fa = isFeatured(a, now) ? 1 : 0;
    var fb = isFeatured(b, now) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    var partner = function (job) { return job && job.source === 'partner' ? 1 : 0; };
    var pa = partner(a);
    var pb = partner(b);
    if (pa !== pb) return pb - pa;

    if (mode === 'match') {
      var as = displayableScore(a && a._match);
      var bs = displayableScore(b && b._match);
      if (as == null && bs == null) {
        /* fall through to recency */
      } else if (as == null) return 1;
      else if (bs == null) return -1;
      else if (bs !== as) return bs - as;
    } else if (mode === 'guest') {
      var ga = guestSortKey(a);
      var gb = guestSortKey(b);
      if (gb.boost !== ga.boost) return gb.boost - ga.boost;
      if (gb.recency !== ga.recency) return gb.recency - ga.recency;
      return ga.idRank - gb.idRank;
    }

    var at = recencyDay(a);
    var bt = recencyDay(b);
    if (bt !== at) return bt - at;
    return stableIdRank(a && a.id) - stableIdRank(b && b.id);
  }

  // Source-diversity interleave for the default (non-match) ordering. Takes a
  // list already sorted by compareJobs and returns a permutation of it:
  //  - the leading Featured / partner block stays exactly where it is;
  //  - no more than maxRun consecutive cards share a source while another
  //    source still has cards;
  //  - Telegram jobs take telegramSlots (positions after the pinned block);
  //  - every source with cards appears within the first `window` cards;
  //  - the relative order inside each source is unchanged.
  // With opts.tier (a number, e.g. 10) the list is a match ranking: only cards
  // whose match score falls in the same tier (floor(score / tier)) as the best
  // remaining card are interleaved, so a weaker tier is never lifted above a
  // stronger one and ranking is preserved across tiers.
  function diversifyBySource(list, opts) {
    var rows = Array.isArray(list) ? list : [];
    opts = opts || {};
    var maxRun = opts.maxRun > 0 ? opts.maxRun : 2;
    var win = opts.window > 0 ? opts.window : 8;
    var slots = Array.isArray(opts.telegramSlots) ? opts.telegramSlots : [1, 4];
    var tgKey = 'telegram_career';
    var srcOf = function (row) { return String((row && row.source) || ''); };
    var tierSize = opts.tier > 0 ? opts.tier : 0;
    var tierOf = function (row) {
      var sc = displayableScore(row && row._match);
      return sc == null ? -1 : Math.floor(sc / tierSize);
    };
    var pinned = 0;
    while (pinned < rows.length && (isFeatured(rows[pinned], opts.now) || srcOf(rows[pinned]) === 'partner')) pinned++;
    var out = rows.slice(0, pinned);
    var order = [];
    var queues = {};
    rows.slice(pinned).forEach(function (row, rank) {
      var key = srcOf(row);
      if (!queues[key]) { queues[key] = []; order.push(key); }
      queues[key].push({ row: row, rank: rank });
    });
    var placed = {};
    var lastKey = null;
    var run = 0;
    out.forEach(function (row) {
      var k = srcOf(row);
      placed[k] = (placed[k] || 0) + 1;
      if (k === lastKey) run++; else { lastKey = k; run = 1; }
    });
    function head(key) { return queues[key].length ? queues[key][0] : null; }
    while (out.length < rows.length) {
      var pos = out.length - pinned;
      var avail = order.filter(head);
      if (tierSize && avail.length > 1) {
        var bestKey = avail.reduce(function (best, k) {
          return head(k).rank < head(best).rank ? k : best;
        }, avail[0]);
        var bestTier = tierOf(head(bestKey).row);
        avail = avail.filter(function (k) { return tierOf(head(k).row) === bestTier; });
      }
      var allowed = avail.filter(function (k) { return !(k === lastKey && run >= maxRun); });
      if (!allowed.length) allowed = avail;
      var pick = null;
      if (allowed.indexOf(tgKey) >= 0 && slots.indexOf(pos) >= 0) pick = tgKey;
      if (!pick && out.length < win) {
        var missing = avail.filter(function (k) { return !placed[k]; });
        var allowedMissing = allowed.filter(function (k) { return !placed[k]; });
        if (allowedMissing.length && missing.length >= win - out.length) pick = allowedMissing[0];
      }
      if (!pick) {
        pick = allowed.reduce(function (best, k) {
          return best == null || head(k).rank < head(best).rank ? k : best;
        }, null);
      }
      out.push(queues[pick].shift().row);
      placed[pick] = (placed[pick] || 0) + 1;
      if (pick === lastKey) run++; else { lastKey = pick; run = 1; }
    }
    return out;
  }

  function listingRejectReason(title, description, tags) {
    var titleText = String(title || '').trim();
    if (!titleText) return 'not-a-job';
    if (/^(вебинар|лекци|конференци|форум|хакатон|митап|meetup|грант|мастер-?класс)/i.test(titleText)) return 'not-a-job';
    if (EVENT_TITLE_INTENT.test(titleText)) return 'not-a-job';
    if (CAREER_ADVICE_TITLE.test(titleText)) return 'not-a-job';
    return null;
  }

  // Work that takes place in another country. hh.kz location is the hiring
  // office (often a Kazakhstan city), so the announcement in the text decides.
  var ABROAD_COUNTRY = '(?:россию|россии|рф|корею|корее|польшу|польше|германию|германии|чехию|чехии|литву|литве|латвию|латвии|эстонию|эстонии|финляндию|финляндии|швецию|швеции|норвегию|норвегии|европу|европе|оаэ|дубай|дубае|турцию|турции|китай|китае|сша|америку|америке|канаду|канаде|японию|японии|израиль|израиле|великобританию|великобритании|англию|англии|италию|италии|испанию|испании|сербию|сербии|болгарию|болгарии|венгрию|венгрии|словакию|словакии|францию|франции|грецию|греции|кипр|кипре|москву|москве|подмосковье|петербург|петербурге|узбекистан|узбекистане)';
  var NOT_WORD_BEFORE = '(?<![а-яёa-z])';
  var NOT_WORD_AFTER = '(?![а-яёa-z])';
  var ABROAD_TITLE = new RegExp(
    NOT_WORD_BEFORE + '(?:в|на)\\s+' + ABROAD_COUNTRY + NOT_WORD_AFTER +
    '|' + NOT_WORD_BEFORE + '(?:работа|работать|вахта|вахтой|вахтов\\w+|трудоустройство|выезд|выездн\\w+|релокация)\\s+(?:в|на|за)\\s+' + ABROAD_COUNTRY + NOT_WORD_AFTER +
    '|' + NOT_WORD_BEFORE + '(?:работа|работать|вахта|вахтой|трудоустройство|выезд\\w*)\\s+за\\s+(?:границ\\w+|рубеж\\w+)' +
    '|' + NOT_WORD_BEFORE + 'за\\s+(?:границ[уей]\\w*|рубеж\\w*)' +
    '|' + NOT_WORD_BEFORE + '(?:work|job|jobs|working|relocation|warehouse\\s+worker)\\s+(?:in|to)\\s+(?:russia|poland|korea|germany|europe|uae|dubai|usa|canada|japan|turkey|china|finland|czechia|lithuania)\\b' +
    '|' + NOT_WORD_BEFORE + '(?:work|job|jobs)\\s+abroad\\b|' + NOT_WORD_BEFORE + 'worker\\s+in\\s+(?:russia|poland|korea|germany|europe|uae|dubai|usa|canada|japan|turkey|china|finland)\\b',
    'i'
  );
  var ABROAD_BODY = new RegExp(
    NOT_WORD_BEFORE + '(?:работа|работать|вахта|вахтой|вахтов\\w+|трудоустройство|выезд\\w*|релокация)\\s+(?:в|на|за)\\s+' + ABROAD_COUNTRY + NOT_WORD_AFTER +
    '|' + NOT_WORD_BEFORE + '(?:работа|работать|вахта|вахтой|трудоустройство)\\s+за\\s+(?:границ\\w+|рубеж\\w+)' +
    '|' + NOT_WORD_BEFORE + 'вахт\\w*\\s+(?:в|на)\\s+' + ABROAD_COUNTRY + NOT_WORD_AFTER +
    '|' + NOT_WORD_BEFORE + 'в\\s+' + ABROAD_COUNTRY + '\\s+на\\s+вахту',
    'i'
  );

  function isAbroadListing(title, description, ctx) {
    if (ctx && ctx.remote) return false;
    if (ABROAD_TITLE.test(String(title || ''))) return true;
    return ABROAD_BODY.test(String(description || ''));
  }

  // Entry-level pay in Kazakhstan is a few hundred thousand tenge. Lower bounds
  // of 600k+/month, or very wide ranges up to 1.5M+, are MLM / commission pitches.
  function implausibleEntryPay(ctx) {
    if (!ctx) return false;
    var cur = String(ctx.currency || ctx.salaryCurrency || '').toUpperCase();
    if (cur && cur !== 'KZT') return false;
    var period = ctx.period || ctx.salaryPeriod || null;
    if (period && period !== 'month') return false;
    var min = Number(ctx.salary_min);
    var max = Number(ctx.salary_max);
    if (!(min > 0)) return false;
    if (min >= 600000) return true;
    return max >= 1500000 && max / min >= 2.5;
  }

  function isStudentSuitable(title, description, tags, ctx) {
    var titleLow = String(title || '').toLowerCase();
    var t = (titleLow + ' ' + String(description || '') + ' ' + (Array.isArray(tags) ? tags.join(' ') : '')).toLowerCase();
    if (/студент\w*[^.]{0,25}(не\s*беспоко|не\s*обраща|не\s*подход|не\s*рассматр)|без\s*студент|не\s*для\s*студент/.test(t)) {
      return { ok: false, reason: 'excludes-students' };
    }
    if (/\b(senior|middle|lead|head)\b|сень[оё]р|синьор|мидл|тимлид|руководител|начальник|директор|главн(ый|ого|ая)|заведующ|управляющ|ведущий\s+специалист|эксперт/.test(titleLow)) {
      return { ok: false, reason: 'senior-title' };
    }
    var requiresExp = /опыт\s*работы|с\s*опытом|опыт\s*от|обязателен\s*опыт|требуется\s*опыт|опыт\s*не\s*менее|стаж\s*(работы|от)|experience\s*(required|of)|years?\s*of\s*experience|опыт\s*в\s*(сфере|продаж|данной)/.test(t);
    var welcomesNoExp = /без\s*опыта|опыт\s*не\s*требуется|опыта\s*не\s*требуется|можно\s*без\s*опыта|no\s*experience|обучение\s*с\s*нуля|обучаем/.test(t);
    if (requiresExp && !welcomesNoExp) return { ok: false, reason: 'requires-experience' };
    if (/(женщин\w*|мужчин\w*|девушк\w*|парн\w*|парень|жен\.|муж\.)\s*(от|до)?\s*\d{2}/.test(t)) {
      return { ok: false, reason: 'age-gender-restricted' };
    }
    var count = function (re) { return (t.match(re) || []).length; };
    if (count(/зарплата/g) >= 2 || count(/обязанности/g) >= 2 || count(/требовани[ея]/g) >= 3) {
      return { ok: false, reason: 'multi-job-digest' };
    }
    if (isAbroadListing(title, description, ctx)) return { ok: false, reason: 'abroad' };
    if (implausibleEntryPay(ctx)) return { ok: false, reason: 'implausible-pay' };
    return { ok: true, reason: '' };
  }

  function listingEligibleForFeed(job) {
    if (!job || job.hiddenAsNonJob) return false;
    return isStudentSuitable(job.title, job.description, job.tags, {
      remote: !!job.remote,
      city: job.city || job.location || '',
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      currency: job.salaryCurrency || job.currency,
      period: job.salaryPeriod || job.salary_period
    }).ok;
  }

  function compareFeedWindow(a, b) {
    var tb = parseTime(b && b.posted_at);
    var ta = parseTime(a && a.posted_at);
    if (tb !== ta) return tb - ta;
    var ida = String(a && a.id != null ? a.id : '');
    var idb = String(b && b.id != null ? b.id : '');
    if (ida === idb) return 0;
    return ida < idb ? 1 : -1;
  }

  function jobsFeedQuery() {
    return 'select=*&status=eq.active&order=posted_at.desc,id.desc&limit=' + FEED_WINDOW;
  }

  // Columns the browser needs for cards, filters, eligibility and match (see
  // mapSupabaseJob / normalizeListing). The detail page re-reads the full row.
  // jobsFeedQuery stays select=* for api/alerts.js.
  var LIST_COLUMNS = 'id,source,source_url,source_type,source_channel,title,company,location,description,' +
    'salary_min,salary_max,currency,tags,posted_at,apply_url,featured_until';

  function jobsListQuery() {
    return 'select=' + LIST_COLUMNS + '&status=eq.active&order=posted_at.desc,id.desc&limit=' + FEED_WINDOW;
  }

  // Telegram-sourced rows are few and old; a second small query keeps them out
  // of the 500-row recency window. Merge without duplicates (first wins).
  function telegramFeedQuery() {
    return 'select=*&source=eq.telegram_career&status=eq.active&order=posted_at.desc,id.desc&limit=' + TELEGRAM_FEED_LIMIT;
  }

  function telegramListQuery() {
    return 'select=' + LIST_COLUMNS + '&source=eq.telegram_career&status=eq.active&order=posted_at.desc,id.desc&limit=' + TELEGRAM_FEED_LIMIT;
  }

  // ── Search: whole-database lookup when local results are thin ───────────
  var SEARCH_MIN_CHARS = 3;
  var SEARCH_THIN_RESULTS = 12;
  var SEARCH_DB_LIMIT = 60;
  var SEARCH_MAX_LEN = 60;

  // Strip everything that could change the meaning of a PostgREST or=() value
  // (separators, parens, wildcards, escapes, quotes, URL delimiters).
  function sanitizeSearchQuery(q) {
    return String(q == null ? '' : q)
      .replace(/[*,()\\"'%_&#=?;:<>{}\[\]|^`~+]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SEARCH_MAX_LEN)
      .trim();
  }

  function searchDbQuery(q) {
    var clean = sanitizeSearchQuery(q);
    if (clean.length < SEARCH_MIN_CHARS) return null;
    var term = '*' + encodeURIComponent(clean) + '*';
    return 'select=' + LIST_COLUMNS + '&status=eq.active' +
      '&or=(title.ilike.' + term + ',company.ilike.' + term + ')' +
      '&order=posted_at.desc,id.desc&limit=' + SEARCH_DB_LIMIT;
  }

  function shouldSearchDatabase(q, localCount) {
    return sanitizeSearchQuery(q).length >= SEARCH_MIN_CHARS && localCount < SEARCH_THIN_RESULTS;
  }

  // 0 = one, 1 = few, 2 = many (en: 0 / 1; kz: no agreement).
  function pluralIndex(n, lang) {
    n = Math.abs(Math.floor(Number(n) || 0));
    if (lang === 'en') return n === 1 ? 0 : 1;
    if (lang === 'kz') return 2;
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 0;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 1;
    return 2;
  }

  // Local rows first, then remote rows not already present; eligibility applies
  // to the remote rows only (local rows already passed it).
  function mergeSearchResults(local, remote, eligible) {
    var seen = {};
    var out = [];
    (Array.isArray(local) ? local : []).forEach(function (row) {
      if (!row) return;
      var key = String(row.id);
      if (seen[key]) return;
      seen[key] = true;
      out.push(row);
    });
    (Array.isArray(remote) ? remote : []).forEach(function (row) {
      if (!row) return;
      var key = String(row.id);
      if (seen[key]) return;
      if (typeof eligible === 'function' && !eligible(row)) return;
      seen[key] = true;
      out.push(row);
    });
    return out;
  }

  // ── Search loader progress ─────────────────────────────────────────────────
  // The founder wants every search to feel worked-for: fast start, long drag.
  // SEARCH_LOADER_MS is the minimum time the loader stays up (change it here).
  // Pure and monotonic in elapsedMs. Fast phase (scaled down only for totals
  // under 4 s): ~60% at 0.6 s, ~89% at 1.0 s; then a slow, irregular crawl
  // from 89% toward 99% over the rest of the time. 100 only when the real work
  // is done AND the minimum time has passed.
  var SEARCH_LOADER_MS = 4000;
  function searchProgressAt(elapsedMs, totalMs, done) {
    var e = +elapsedMs; if (!(e > 0)) e = 0;
    var total = +totalMs > 0 ? +totalMs : SEARCH_LOADER_MS;
    var k = Math.min(1, total / 4000);
    var t60 = 600 * k, t89 = 1000 * k;
    var percent;
    if (done && e >= total) {
      percent = 100;
    } else if (e <= t60) {
      var x = e / t60;
      percent = 60 * (1 - Math.pow(1 - x, 2));
    } else if (e <= t89) {
      var y = (e - t60) / (t89 - t60);
      percent = 60 + 29 * (1 - Math.pow(1 - y, 2));
    } else {
      var span = Math.max(1, total - t89);
      var z = Math.min(1, (e - t89) / span);
      // stop-and-go: derivative of the warp stays positive (>= 0.1)
      var w = z + 0.65 * Math.sin(6 * Math.PI * z) / (6 * Math.PI) + 0.25 * Math.sin(14 * Math.PI * z) / (14 * Math.PI);
      percent = 89 + 10 * Math.min(1, Math.max(0, w));
      if (e > total) percent = Math.min(99.9, percent + 0.9 * (1 - Math.exp(-(e - total) / 4000)));
      if (percent >= 100) percent = 99.9;
    }
    var finished = percent >= 100;
    var filled = finished ? 5 : e >= t89 ? 4 : e >= t60 ? 3 : Math.min(3, Math.floor(e / (t60 / 3)));
    return {
      percent: percent,
      filled: filled,
      active: finished ? -1 : filled,
      stage: percent < 60 ? 0 : percent < 89 ? 1 : 2
    };
  }

  // Latest-wins token: a response is applied only if its token is still current.
  function createRequestGuard() {
    var current = 0;
    return {
      next: function () { return ++current; },
      isCurrent: function (token) { return token === current; },
      cancel: function () { current++; }
    };
  }

  function mergeFeedRows(primary, extra) {
    var out = [];
    var seen = {};
    [primary, extra].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (row) {
        if (!row) return;
        var key = String(row.id);
        if (seen[key]) return;
        seen[key] = true;
        out.push(row);
      });
    });
    return out;
  }

  function isTelegramJob(job) {
    return !!job && job.source === 'telegram_career';
  }

  function takeFeedWindow(rows) {
    return (rows || []).slice().sort(compareFeedWindow).slice(0, FEED_WINDOW);
  }

  function selectFeedListings(rows) {
    return takeFeedWindow(rows).map(normalizeListing).filter(listingEligibleForFeed);
  }

  // Short paid training / probation in a regular job is not the role type.
  var INCIDENTAL_INTERNSHIP = new RegExp(
    'оплачиваем' + WORD + '*\\s+стажировк' + WORD + '*\\s+\\d+\\s*(?:день|дня|дней|сутк' + WORD + '*)(?:\\s+при\\s+успешном\\s+прохождении)?' +
    '|стажировк' + WORD + '*\\s+\\d+\\s*(?:день|дня|дней|сутк' + WORD + '*)(?:\\s+при\\s+успешном\\s+прохождении)?' +
    '|при\\s+успешном\\s+прохождении.{0,48}стажировк' +
    '|стажировк' + WORD + '*.{0,40}при\\s+успешном\\s+прохождении' +
    '|испытательн' + WORD + '*\\s+срок' +
    '|вводн' + WORD + '+\\s+(?:стажировк|обучен)' +
    '|paid\\s+(?:internship|training)\\s+(?:of\\s+)?\\d+\\s*-?\\s*(?:day|days)' +
    '|\\d+\\s*-?\\s*day\\s+paid\\s+(?:internship|training)' +
    '|probationary\\s+(?:period|training)',
    'gi'
  );

  function stripIncidentalInternship(text) {
    return String(text || '').replace(INCIDENTAL_INTERNSHIP, ' ');
  }

  function inferInternship(job) {
    var title = String((job && job.title) || '').toLowerCase();
    var desc = stripIncidentalInternship(String((job && job.description) || '').toLowerCase());
    var tags = Array.isArray(job && job.tags) ? job.tags.join(' ').toLowerCase() : '';
    var titleHit = /стажировк|стажёр|стажер|\binternship\b|\bintern\b|trainee|тағылымдама/.test(title);
    var descHit = /стажировк|\binternship\b|\bintern\b|trainee|тағылымдама/.test(desc);
    var tagHit = /стажировк|intern|trainee/.test(tags);
    if (titleHit) return { internship: true, confidence: 'high', uncertain: false };
    if (descHit) return { internship: true, confidence: 'medium', uncertain: false };
    if (tagHit) return { internship: false, confidence: 'tag-only', uncertain: true };
    return { internship: false, confidence: 'none', uncertain: false };
  }

  var SALARY_HINT = /зарплат|заработн|оклад|з\s*\/\s*п|\bзп\b|salary|\bpay\b|компенсац|доход|оплат|тенге|tenge|тг|kzt|₸|\$|usd|доллар|руб|rub|₽|eur|€/i;
  var COUNT_OR_EXP_AFTER = /^\s*(?:лет|года|год|years?|человек|сотрудник|конференц|conferences?|форум|вебинар)/i;
  var COUNT_OR_EXP_BEFORE = /(?:опыт|experience|команда|штат)\s*$/i;
  var THOUSANDS_UNIT = /^(?:тыс(?:яч)?|\bk\b|к)$/i;

  function emptySalaryParse() {
    return { min: null, max: null, currency: null, period: null, thousands: false, raw: null, comparable: false };
  }

  function detectCurrency(text) {
    var s = String(text || '');
    if (/\$|usd|доллар/i.test(s)) return 'USD';
    if (/€|eur/i.test(s)) return 'EUR';
    if (/₽|руб|\brub\b/i.test(s)) return 'RUB';
    if (/₸|тенге|tenge|kzt|(?:^|[^0-9a-zа-яёәіңғүұқөһ])тг(?:[^0-9a-zа-яёәіңғүұқөһ]|$)/i.test(s)) return 'KZT';
    return null;
  }

  function detectPeriod(text) {
    var s = String(text || '');
    if (/в\s*час|\/\s*час|hourly|per\s*hour/i.test(s)) return 'hour';
    if (/в\s*день|\/\s*день|\/\s*day|daily|per\s*day/i.test(s)) return 'day';
    if (/в\s*месяц|\/\s*мес|monthly|per\s*month/i.test(s)) return 'month';
    return null;
  }

  function parseAmount(raw) {
    var n = parseInt(String(raw).replace(/\s/g, ''), 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  function parseSalaryFromText(text) {
    var src = String(text || '');
    var empty = emptySalaryParse();
    if (!SALARY_HINT.test(src)) return empty;

    function tightWindow(index, length) {
      return src.slice(Math.max(0, index - 18), index + length + 22);
    }

    function skipCountOrExperience(index, length) {
      var before = src.slice(Math.max(0, index - 18), index);
      var after = src.slice(index + length, index + length + 18);
      return COUNT_OR_EXP_BEFORE.test(before) || COUNT_OR_EXP_AFTER.test(after);
    }

    function skipClockTime(index, length) {
      var ctx = src.slice(Math.max(0, index - 4), index + length + 4);
      return /\d{1,2}:\d{2}/.test(ctx);
    }

    var rangeRe = /(\d[\d\s]{0,8})\s*[–\-]\s*(\d[\d\s]{0,8})(?:\s*(тыс(?:яч)?|(?<![a-z])k(?![a-zа-яё])|к))?/gi;
    var match;
    var chosen = null;
    while ((match = rangeRe.exec(src))) {
      if (skipCountOrExperience(match.index, match[0].length)) continue;
      if (skipClockTime(match.index, match[0].length)) continue;
      var around = tightWindow(match.index, match[0].length);
      if (!SALARY_HINT.test(around)) continue;
      chosen = {
        min: parseAmount(match[1]),
        max: parseAmount(match[2]),
        snippet: match[0],
        around: around,
        thousands: !!(match[3] && THOUSANDS_UNIT.test(match[3]))
      };
      break;
    }
    if (!chosen) {
      var singleRe = /(\d[\d\s]{1,8})(?:\s*(тыс(?:яч)?|(?<![a-z])k(?![a-zа-яё])|к))?/gi;
      while ((match = singleRe.exec(src))) {
        if (skipCountOrExperience(match.index, match[0].length)) continue;
        if (skipClockTime(match.index, match[0].length)) continue;
        around = tightWindow(match.index, match[0].length);
        if (!SALARY_HINT.test(around)) continue;
        chosen = {
          min: parseAmount(match[1]),
          max: null,
          snippet: match[0],
          around: around,
          thousands: !!(match[2] && THOUSANDS_UNIT.test(match[2]))
        };
        break;
      }
    }
    if (!chosen) return empty;
    var min = chosen.min;
    var max = chosen.max;
    if (chosen.thousands) {
      if (min) min *= 1000;
      if (max) max *= 1000;
    }
    var currency = detectCurrency(chosen.around) || detectCurrency(src);
    var period = detectPeriod(chosen.around) || detectPeriod(src);
    return {
      min: min,
      max: max,
      currency: currency,
      period: period,
      thousands: !!chosen.thousands,
      raw: chosen.snippet,
      comparable: !!(currency && (min || max))
    };
  }

  function sanitizeSalary(min, max, meta) {
    var m = (typeof min === 'number' && isFinite(min) && min > 0) ? min : null;
    var M = (typeof max === 'number' && isFinite(max) && max > 0) ? max : null;
    if (m && M && m > M) { var tmp = m; m = M; M = tmp; }
    return {
      min: m,
      max: M,
      currency: meta && meta.currency || null,
      period: meta && meta.period || null
    };
  }

  function relativeDiff(a, b) {
    if (!a || !b) return 0;
    return Math.abs(a - b) / Math.max(a, b);
  }

  function salariesComparable(a, b) {
    if (!a || !b) return false;
    if (!a.currency || !b.currency || a.currency !== b.currency) return false;
    if (!(a.min || a.max) || !(b.min || b.max)) return false;
    if (a.period && b.period) return a.period === b.period;
    if (!a.period && !b.period) return true;
    return (a.period || 'month') === (b.period || 'month');
  }

  function reconcileSalary(structuredMin, structuredMax, description, meta) {
    var structured = sanitizeSalary(structuredMin, structuredMax, meta);
    structured.comparable = !!(structured.currency && (structured.min || structured.max));
    var fromText = parseSalaryFromText(description);
    var uncertain = false;
    if (salariesComparable(structured, fromText)) {
      if (fromText.min && structured.min && relativeDiff(fromText.min, structured.min) >= 0.15) uncertain = true;
      if (fromText.max && structured.max && relativeDiff(fromText.max, structured.max) >= 0.15) uncertain = true;
    } else if (fromText.comparable && structured.comparable && fromText.currency !== structured.currency) {
      uncertain = true;
    } else if (fromText.comparable && structured.comparable && fromText.period && structured.period && fromText.period !== structured.period) {
      uncertain = true;
    }
    return {
      min: structured.min,
      max: structured.max,
      currency: structured.currency,
      period: structured.period,
      uncertain: uncertain,
      rewritten: false,
      textRange: fromText
    };
  }

  function currencySuffix(code) {
    if (code === 'USD') return '$';
    if (code === 'EUR') return '€';
    if (code === 'RUB') return '₽';
    if (code === 'KZT') return '₸';
    return '';
  }

  function periodSuffix(period) {
    if (period === 'day') return '/день';
    if (period === 'hour') return '/час';
    if (period === 'month') return '/мес';
    return '';
  }

  // Non-breaking spaces keep "от 950 000 ₸" together: the number never loses
  // its currency (or its "от"/"до") to a new line.
  var NBSP = '\u00A0';

  function nbspMoney(text) {
    return String(text == null ? '' : text)
      .replace(/^(от|до|from|up to)\s+/i, function (m, w) { return w + NBSP; })
      .replace(/(\d)[ \u2009\u202F](?=\d{3}(?!\d))/g, '$1' + NBSP)
      .replace(/(\d)\s+(?=[₸$€₽])/g, '$1' + NBSP)
      .replace(/(\d)\s+(?=(?:тг|тенге|kzt)(?![а-яёa-z]))/gi, '$1' + NBSP)
      .replace(/\s+(?=[₸$€₽](?![а-яёa-z]))/g, NBSP);
  }

  function formatSalary(min, max, meta) {
    var currency = meta && meta.currency;
    var period = meta && meta.period;
    var mark = currencySuffix(currency);
    var per = periodSuffix(period);
    var unit = (mark ? NBSP + mark : '') + per;
    if (min && max && min !== max) return min.toLocaleString('ru') + '–' + max.toLocaleString('ru') + unit;
    if (min && max && min === max) return min.toLocaleString('ru') + unit;
    if (min) return 'от' + NBSP + min.toLocaleString('ru') + unit;
    if (max) return 'до' + NBSP + max.toLocaleString('ru') + unit;
    return '—';
  }

  function paginate(items, visibleCount, pageSize) {
    var size = pageSize || BROWSE_PAGE_SIZE;
    var total = Array.isArray(items) ? items.length : 0;
    var visible = Math.max(size, visibleCount || size);
    var slice = (items || []).slice(0, visible);
    return {
      total: total,
      visible: slice.length,
      remaining: Math.max(0, total - slice.length),
      pageSize: size,
      items: slice
    };
  }

  function normalizeAlertSpec(spec) {
    var raw = spec || {};
    var filters = unique(asArray(raw.filters)).filter(function (f) { return KNOWN_FLAGS.indexOf(f) !== -1; });
    filters.sort();
    return {
      filters: filters,
      cities: unique(asArray(raw.cities != null ? raw.cities : raw.city)),
      cats: unique(asArray(raw.cats != null ? raw.cats : raw.cat)),
      q: String(raw.q || '').trim()
    };
  }

  function alertSpecKey(spec) {
    var n = normalizeAlertSpec(spec);
    return JSON.stringify({ f: n.filters, c: n.cities.slice().sort(), k: n.cats.slice().sort(), q: n.q.toLowerCase() });
  }

  function classifyAlertDispatch(res) {
    var status = res && res.status;
    var json = (res && res.json) || {};
    if (!status) return 'error';
    if (status === 200 && json.reason === 'in_flight') return 'pending';
    if (status === 409 && (json.reason === 'idempotency_expired' || json.reason === 'idempotency_conflict')) {
      return 'ambiguous';
    }
    if (status === 200 && json.delivered === true) return json.retried ? 'already' : 'sent';
    if (status === 200 && json.delivered === false && Number(json.count) === 0) {
      return Number(json.deduped) > 0 ? 'already' : 'none';
    }
    return 'error';
  }

  function alertIsActive(spec) {
    var n = normalizeAlertSpec(spec);
    return !!(n.filters.length || n.cities.length || n.cats.length || n.q);
  }

  function flagHolds(job, flag, helpers) {
    var tests = Object.assign({}, defaultFlagTests(), (helpers && helpers.flagTests) || {});
    var test = tests[flag];
    return typeof test === 'function' ? !!test(job) : true;
  }

  function jobMatchesSpec(job, spec, helpers) {
    if (!job) return false;
    var n = normalizeAlertSpec(spec);
    for (var i = 0; i < n.filters.length; i++) {
      if (!flagHolds(job, n.filters[i], helpers)) return false;
    }
    if (n.cities.length) {
      var city = String(job.city || '');
      var cityHit = n.cities.some(function (c) { return city.indexOf(c) !== -1; });
      if (!cityHit) return false;
    }
    if (n.cats.length) {
      var detected = helpers && typeof helpers.detectIndustry === 'function' ? helpers.detectIndustry(job) : null;
      var cat = detected || job.category;
      if (n.cats.indexOf(cat) === -1) return false;
    }
    if (n.q) {
      var hay = ((job.title || '') + ' ' + (job.company || '')).toLowerCase();
      if (hay.indexOf(n.q.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function matchingJobs(jobs, spec, helpers) {
    return (jobs || []).filter(function (job) { return jobMatchesSpec(job, spec, helpers); });
  }

  /**
   * Browse-list entry point. Same predicates as alerts, but this is the path
   * the Browse grid uses. Tests must call this and matchingJobIds separately.
   */
  function filterBrowseJobs(jobs, browseState, helpers) {
    var state = browseState || {};
    return matchingJobs(jobs, {
      filters: state.filters || state.flags || [],
      cities: state.cities != null ? state.cities : state.city,
      cats: state.cats != null ? state.cats : state.cat,
      q: state.q
    }, helpers);
  }

  function matchingJobIds(jobs, spec, helpers) {
    return matchingJobs(jobs, spec, helpers).map(function (job) { return String(job.id); });
  }

  function mergeSeenIds(prev, extra, currentMatchIds, cap) {
    var capN = cap || SEEN_ID_CAP;
    var keep = {};
    var out = [];
    function add(id) {
      var key = String(id == null ? '' : id);
      if (!key || keep[key]) return;
      keep[key] = true;
      out.push(key);
    }
    (currentMatchIds || []).forEach(add);
    (prev || []).forEach(add);
    (extra || []).forEach(add);
    if (out.length <= capN) return out;
    var preferred = {};
    (currentMatchIds || []).forEach(function (id) { preferred[String(id)] = true; });
    var trimmed = Object.keys(preferred);
    out.forEach(function (id) {
      if (trimmed.length >= capN) return;
      if (!preferred[id]) trimmed.push(id);
    });
    return trimmed.slice(0, capN);
  }

  function newMatchesFor(alert, jobs, helpers) {
    if (!alert || !Array.isArray(jobs)) return [];
    var seen = {};
    (alert.lastSeenIds || []).forEach(function (id) { seen[String(id)] = true; });
    return matchingJobs(jobs, alert, helpers).filter(function (job) {
      return !seen[String(job.id)];
    });
  }

  function consumeAlertMatches(alert, jobs, helpers) {
    var current = matchingJobIds(jobs, alert, helpers);
    var extra = newMatchesFor(alert, jobs, helpers).map(function (job) { return String(job.id); });
    return Object.assign({}, alert, {
      lastSeen: Date.now(),
      lastSeenIds: mergeSeenIds(alert.lastSeenIds, extra, current)
    });
  }

  function seedAlert(spec, jobs, helpers, now) {
    var n = normalizeAlertSpec(spec);
    var ids = matchingJobIds(jobs, n, helpers);
    var ts = now || Date.now();
    return Object.assign({}, n, {
      id: 'a_' + ts.toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      key: alertSpecKey(n),
      ts: ts,
      lastSeen: ts,
      lastSeenIds: mergeSeenIds([], [], ids),
      emailOptIn: false
    });
  }

  function canSaveAlert(existingAlerts, spec) {
    var key = alertSpecKey(spec);
    var duplicate = (existingAlerts || []).some(function (a) { return alertSpecKey(a) === key; });
    if (duplicate) return { ok: false, reason: 'duplicate' };
    return { ok: true };
  }

  function applyAlertEdit(existing, nextSpec) {
    var merged = Object.assign({}, existing, normalizeAlertSpec(nextSpec));
    merged.id = existing && existing.id ? existing.id : merged.id;
    merged.lastSeenIds = Array.isArray(existing && existing.lastSeenIds) ? existing.lastSeenIds.slice() : [];
    merged.lastSeen = existing && existing.lastSeen ? existing.lastSeen : Date.now();
    merged.key = alertSpecKey(merged);
    if (nextSpec && Object.prototype.hasOwnProperty.call(nextSpec, 'emailOptIn')) {
      merged.emailOptIn = !!nextSpec.emailOptIn;
    } else {
      merged.emailOptIn = !!(existing && existing.emailOptIn);
    }
    merged.emailSyncPending = existing && existing.emailSyncPending ? existing.emailSyncPending : null;
    merged.emailSyncError = existing && existing.emailSyncError ? existing.emailSyncError : null;
    return merged;
  }

  function listingBlob(job) {
    return [
      (job && job.title) || '',
      (job && job.description) || '',
      Array.isArray(job && job.tags) ? job.tags.join(' ') : ''
    ].join(' ').toLowerCase();
  }

  function detectIndustry(job) {
    var text = listingBlob(job);
    if (/разработчик|developer|программист|software|frontend|backend|fullstack|qa|тестировщик|devops|python|javascript|java|kotlin|swift|android|ios|data.?scientist|machine.?learning|\bml\b|\bai\b|нейросет|искусственный.интеллект|it.специалист|технический|технолог/.test(text)) return 'it';
    if (/финанс|бухгалт|accountant|economist|экономист|banking|банк|кредит|инвест|аудит|налог|казначей|treasury/.test(text)) return 'finance';
    if (/маркетинг|marketing|\bsmm\b|\bseo\b|контент.?менеджер|рекламa|реклам|brand|бренд|\bpr\b|пиар|digital|продвижение/.test(text)) return 'marketing';
    if (/дизайн|design|\bui\b|\bux\b|figma|photoshop|illustrator|graphic|визуальный|креатив|creative/.test(text)) return 'design';
    if (/\bhr\b|кадр|рекрут|human.resource|подбор.персонал|hr.менеджер|hr.специалист/.test(text)) return 'hr';
    if (/продаж|sales|менеджер.по.прод|account.manager|торговый.представитель|клиент.менеджер/.test(text)) return 'sales';
    return null;
  }

  function inferNoExp(job) {
    return /без.опыта|no.experience|\bjunior\b|стажёр|стажер|начинающий|студент|intern|trainee/.test(listingBlob(job));
  }

  function inferFlexible(job, type, remote) {
    if (remote || type === 'part-time') return true;
    return /гибк|flexible|неполн|свободн|фриланс|freelance|удалённо|remote|дистанц/.test(listingBlob(job));
  }

  /**
   * One listing shape for Browse cards and alert-email matching.
   * Type/tags/category/internship/salary flags must not be inferred twice.
   */
  function normalizeListing(row) {
    var job = row && typeof row === 'object' ? row : {};
    var tags = Array.isArray(job.tags) ? job.tags.slice() : [];
    var tagStr = tags.join(' ').toLowerCase();
    var intern = inferInternship(job);
    var isPart = /частичн|part-time|подработк/.test(tagStr) || job.type === 'part-time';
    var isRemote = /удалённо|удаленно|remote|дистанц/.test(tagStr) || !!job.remote || !!job.is_remote;
    var type = intern.internship ? 'internship' : (isPart ? 'part-time' : 'full-time');
    var salaryMeta = {
      currency: job.currency || job.salaryCurrency || null,
      period: job.salary_period || job.salaryPeriod || null
    };
    var rec = reconcileSalary(job.salary_min, job.salary_max, job.description, salaryMeta);
    var salary = '—';
    var salarySource = 'none';
    if (rec.min || rec.max) {
      salary = formatSalary(rec.min, rec.max, { currency: rec.currency, period: rec.period });
      salarySource = 'structured';
    } else if (job.salary && job.salary !== '—') {
      salary = String(job.salary);
      salarySource = 'preformatted';
    } else if (rec.textRange && rec.textRange.comparable) {
      salarySource = 'text';
    }
    var reject = listingRejectReason(job.title, job.description, tags);
    var detected = detectIndustry(job);
    return {
      id: job.id,
      title: job.title || '',
      company: job.company || job.company_name || '',
      city: job.city || job.location || '',
      description: job.description || '',
      tags: tags,
      type: type,
      remote: isRemote,
      noExp: inferNoExp(job),
      flexible: inferFlexible(job, type, isRemote),
      category: detected || job.category || null,
      salary: salary,
      salary_min: rec.min,
      salary_max: rec.max,
      salaryPeriod: rec.period,
      salaryCurrency: rec.currency,
      salaryUncertain: !!rec.uncertain,
      salarySource: salarySource,
      internshipUncertain: !!intern.uncertain,
      hiddenAsNonJob: reject === 'not-a-job',
      url: job.apply_url || job.source_url || job.url || '',
      apply_url: job.apply_url || null
    };
  }

  function defaultFlagTests() {
    return {
      internship: function (j) { return j.type === 'internship'; },
      'part-time': function (j) { return j.type === 'part-time'; },
      remote: function (j) { return !!j.remote; },
      'no-exp': function (j) { return !!j.noExp; },
      flexible: function (j) { return !!j.flexible; },
      'paid-intern': function (j) { return j.type === 'internship' && j.salary && j.salary !== '—'; },
      'has-salary': function (j) { return !!(j.salary && j.salary !== '—'); },
      telegram: function (j) { return isTelegramJob(j); }
    };
  }

  // ── Apply action, contact masking, pre-written message ──────────────────

  var MESSAGE_KINDS = ['email', 'whatsapp', 'telegram_dm'];
  // First path segments of t.me that are not usernames.
  var TME_RESERVED = ['s', 'c', 'joinchat', 'share', 'addlist', 'addstickers', 'addemoji', 'addtheme',
    'proxy', 'socks', 'm', 'boost', 'login', 'invoice', 'giftcode', 'contact', 'setlanguage', 'iv', 'msg'];

  function phoneDigits(raw) {
    var d = String(raw || '').replace(/\D+/g, '');
    if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
    return d;
  }

  function classifyApply(job) {
    var j = job || {};
    var raw = String(j.apply_url || j.url || '').trim();
    var hint = String(j.source_type || '');
    var m;
    if (/^mailto:/i.test(raw)) {
      var email = raw.slice(7).split('?')[0].trim();
      try { email = decodeURIComponent(email); } catch (_e) { /* keep raw */ }
      if (/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) {
        return { kind: 'email', href: 'mailto:' + email, email: email };
      }
      return { kind: 'site', href: '' };
    }
    if (/^tel:/i.test(raw)) {
      var digits = phoneDigits(raw.slice(4));
      if (!digits) return { kind: 'site', href: '' };
      var phone = { kind: 'phone', href: 'tel:+' + digits, phoneDigits: digits };
      if (/^77\d{9}$/.test(digits)) phone.whatsappHref = 'https://wa.me/' + digits;
      return phone;
    }
    m = raw.match(/^https?:\/\/(?:www\.)?(?:wa\.me\/\+?|api\.whatsapp\.com\/send\/?\?phone=\+?)(\d{6,15})/i);
    if (m) return { kind: 'whatsapp', href: 'https://wa.me/' + m[1], phoneDigits: m[1] };
    m = raw.match(/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\/([^?#]*)/i);
    if (m) {
      var path = m[1].replace(/\/+$/, '');
      var parts = path ? path.split('/') : [];
      var first = parts[0] || '';
      var isUser = parts.length === 1 && /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(first) &&
        TME_RESERVED.indexOf(first.toLowerCase()) === -1;
      // The row's own channel is never a person to write to.
      var channel = String(j.source_channel || '').replace(/^@/, '').toLowerCase();
      var isOwnChannel = !!channel && first.toLowerCase() === channel;
      if (isUser && hint !== 'telegram_post' && !isOwnChannel) {
        var kind = /bot$/i.test(first) ? 'telegram_bot' : 'telegram_dm';
        return { kind: kind, href: 'https://t.me/' + first, username: first };
      }
      // Channel, post, invite or folder link: open the original post.
      var postHref = /^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i.test(String(j.source_url || '').trim())
        ? String(j.source_url).trim() : raw;
      return { kind: 'telegram_post', href: postHref.replace(/^http:/i, 'https:') };
    }
    if (/^https?:\/\//i.test(raw)) {
      var isForm = hint === 'form' ||
        /^https?:\/\/(?:forms\.gle|forms\.office\.com|[a-z0-9-]+\.typeform\.com|tally\.so|forms\.yandex\.[a-z]+)\//i.test(raw) ||
        /^https?:\/\/docs\.google\.com\/forms\//i.test(raw);
      try { new URL(raw); } catch (_e2) { return { kind: 'site', href: '' }; }
      return { kind: isForm ? 'form' : 'site', href: raw };
    }
    return { kind: 'site', href: '' };
  }

  var MASK_MARK = '\uE000';
  var PHONE_RE = /(^|[^\d])((?:\+7|[78])[\s\-.()]*\d{3}[\s\-.()]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2})(?!\d)/g;
  var EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
  var LINK_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me|wa\.me)\/[^\s<>"')]+/gi;
  var HANDLE_RE = /(^|[^\w@.\/\-])@[A-Za-z][A-Za-z0-9_]{3,31}(?![\w@])/g;
  var MASK_RUN_RE = new RegExp(MASK_MARK + '(?:(?:\\s+(?:или|и|or)\\s+|[\\s,;|/·•–—-]+)' + MASK_MARK + ')*', 'g');

  // Replaces emails, phone numbers, @usernames and t.me / wa.me links with one
  // short note. Used only for Telegram-sourced descriptions.
  function maskContacts(text, note) {
    var s = String(text == null ? '' : text);
    if (!s) return '';
    var replacement = note == null ? '' : String(note);
    s = s.replace(EMAIL_RE, MASK_MARK);
    s = s.replace(LINK_RE, MASK_MARK);
    s = s.replace(PHONE_RE, function (_m, pre) { return pre + MASK_MARK; });
    s = s.replace(HANDLE_RE, function (_m, pre) { return pre + MASK_MARK; });
    return s.replace(MASK_RUN_RE, function () { return replacement; });
  }

  function fillTemplate(str, vars) {
    return String(str == null ? '' : str).replace(/\{(\w+)\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
    });
  }

  function matchingSkills(job, profile, max) {
    var p = profileSignals(profile);
    var j = job || {};
    var hay = [j.title, j.description, Array.isArray(j.tags) ? j.tags.join(' ') : '',
      Array.isArray(j.skills) ? j.skills.join(' ') : ''].join(' ');
    var out = [];
    p.skills.forEach(function (skill) {
      if (out.length >= max) return;
      var label = String(skill).trim();
      if (label && out.indexOf(label) === -1 && skillInText(label, hay)) out.push(label);
    });
    return out;
  }

  // tpl: { subject, greeting, intro, name, uni, skills, ask, thanks } with
  // {title} {name} {uni} {skills} placeholders, already in the site language.
  function buildApplyMessage(job, profile, tpl) {
    var t = tpl || {};
    var title = String((job && job.title) || '').trim();
    var p = profileSignals(profile);
    var uni = profile && typeof profile.uni === 'string' ? profile.uni.trim().slice(0, 160) : '';
    var name = p.name.slice(0, 60);
    var vars = { title: title };
    var lines = [fillTemplate(t.intro, vars)];
    if (name) lines.push(fillTemplate(t.name, { name: name }));
    if (uni) lines.push(fillTemplate(t.uni, { uni: uni }));
    var skills = matchingSkills(job, profile, 3);
    if (skills.length) lines.push(fillTemplate(t.skills, { skills: skills.join(', ') }));
    var body = [
      fillTemplate(t.greeting, vars),
      lines.filter(Boolean).join(' '),
      fillTemplate(t.ask, vars),
      fillTemplate(t.thanks, vars) + (name ? '\n' + name : '')
    ].filter(function (part) { return part; }).join('\n\n');
    return { subject: fillTemplate(t.subject, vars), body: body };
  }

  // After a language switch: keep what the user typed only if it differs from
  // the message we generated for them; otherwise use the regenerated one.
  function carryApplyBody(typed, prevAuto, nextAuto) {
    var norm = function (v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim(); };
    if (!norm(typed) || norm(typed) === norm(prevAuto)) return nextAuto;
    return String(typed);
  }

  // Builds the final link at click time from the (possibly edited) message.
  function buildApplyHref(action, message) {
    var a = action || {};
    var m = message || {};
    var body = encodeURIComponent(String(m.body == null ? '' : m.body));
    if (a.kind === 'email' && a.email) {
      return 'mailto:' + a.email + '?subject=' + encodeURIComponent(String(m.subject == null ? '' : m.subject)) + '&body=' + body;
    }
    if (a.kind === 'whatsapp' && a.phoneDigits) return 'https://wa.me/' + a.phoneDigits + '?text=' + body;
    // Telegram documents ?text=<draft_text> for public username links
    // (core.telegram.org/api/links, "Public username links").
    if (a.kind === 'telegram_dm' && a.username) return 'https://t.me/' + a.username + '?text=' + body;
    return a.href || '';
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  var HASH_VIEWS = ['home', 'browse', 'saved', 'profile', 'alerts'];

  function jobPath(id) { return '/job/' + encodeURIComponent(String(id)); }
  function jobUrl(id) { return SITE_ORIGIN + jobPath(id); }

  function routeUrl(view, jobId) {
    if (view === 'landing' || !view) return '/';
    if (view === 'job' && jobId != null && jobId !== '') return jobPath(jobId);
    return '/#/' + view;
  }

  // pathname + hash -> { view, jobId, url, legacy }. view is null when the hash
  // is a plain page anchor (#how) that is not a route.
  function parseRoute(pathname, hash) {
    var path = String(pathname || '/');
    var h = String(hash || '');
    var m = path.match(/^\/job\/(\d+)\/?$/);
    if (m) return { view: 'job', jobId: m[1], url: jobPath(m[1]), legacy: false };
    m = h.match(/^#\/job\/(\d+)\/?(?:[?#].*)?$/);
    if (m) return { view: 'job', jobId: m[1], url: jobPath(m[1]), legacy: true };
    if (!h || h === '#') return { view: 'landing', jobId: null, url: '/', legacy: false };
    m = h.match(/^#\/(home|browse|saved|profile|alerts|submit)(?:[/?#].*)?$/);
    if (m) return { view: m[1], jobId: null, url: '/#/' + m[1], legacy: false };
    if (/^#\/job(?:\/|$)/.test(h)) return { view: 'landing', jobId: null, url: '/', legacy: false };
    return { view: null, jobId: null, url: null, legacy: false };
  }

  function shareTelegramUrl(id, title) {
    return 'https://t.me/share/url?url=' + encodeURIComponent(jobUrl(id)) + '&text=' + encodeURIComponent(String(title || ''));
  }

  // ── Employer / claim mail ───────────────────────────────────────────────

  function mailto(address, subject, body) {
    return 'mailto:' + address + '?subject=' + encodeURIComponent(String(subject || '')) +
      '&body=' + encodeURIComponent(String(body || ''));
  }

  function employerMailto(tpl) {
    var t = tpl || {};
    return mailto(EMPLOYER_EMAIL, t.subject, t.body);
  }

  function claimMailto(job, tpl) {
    var t = tpl || {};
    var id = job && job.id != null ? String(job.id) : '';
    var vars = { id: id, url: id ? jobUrl(id) : '' };
    return mailto(EMPLOYER_EMAIL, fillTemplate(t.subject, vars), fillTemplate(t.body, vars));
  }

  // ── Resume upload progress ────────────────────────────────────────────────
  // Pure helpers: the page drives them from requestAnimationFrame and turns the
  // step descriptors into ru/kz/en text. Nothing here is a hard-coded stop point.
  var PROGRESS_MIN_FIRST_MS = 2200;
  var PROGRESS_MIN_REPEAT_MS = 1000;
  var PROGRESS_MIN_REDUCED_MS = 800;
  var PROGRESS_CEILING = 94.9;
  var PROGRESS_MAX_CHIPS = 8;

  // Minimum wait for one run and the total the user actually waits: when the
  // real work is slower than the minimum, the bar follows it and adds nothing.
  function progressDuration(opts) {
    opts = opts || {};
    var minMs = opts.reducedMotion ? PROGRESS_MIN_REDUCED_MS
      : (opts.firstRun ? PROGRESS_MIN_FIRST_MS : PROGRESS_MIN_REPEAT_MS);
    var real = typeof opts.realMs === 'number' && isFinite(opts.realMs) && opts.realMs > 0 ? opts.realMs : 0;
    return { minMs: minMs, totalMs: Math.max(minMs, real), shimmer: !opts.reducedMotion };
  }

  // Asymptotic ease: a fast component (~72%) plus a slow one that crawls toward
  // a 95% ceiling. Reaches 100 only when the real work has resolved AND the
  // minimum time has elapsed.
  function progressAt(elapsedMs, opts) {
    opts = opts || {};
    var t = Math.max(0, Number(elapsedMs) || 0);
    if (opts.resolved && t >= (opts.minMs || 0)) return 100;
    var p = 72 * (1 - Math.exp(-t / 250)) + 23 * (1 - Math.exp(-t / 1400));
    return Math.min(p, PROGRESS_CEILING);
  }

  function skillChips(skills, max) {
    var limit = max > 0 ? max : PROGRESS_MAX_CHIPS;
    var seen = {};
    var list = [];
    (Array.isArray(skills) ? skills : []).forEach(function (s) {
      var label = String(s == null ? '' : s).trim();
      var key = label.toLowerCase();
      if (!label || seen[key]) return;
      seen[key] = true;
      list.push(label);
    });
    return { shown: list.slice(0, limit), more: Math.max(0, list.length - limit) };
  }

  // Step descriptors with the real numbers; text lives in the page's T dictionary.
  function buildProgressSteps(counts) {
    counts = counts || {};
    var chips = skillChips(counts.skills);
    var jobs = Math.max(0, Number(counts.jobCount) || 0);
    var matches = Math.max(0, Number(counts.matchCount) || 0);
    var hasSkills = chips.shown.length > 0;
    return [
      { key: 'read' },
      hasSkills ? { key: 'skills', chips: chips } : { key: 'skills_none', chips: chips },
      jobs > 0 ? { key: 'compare', n: jobs } : { key: 'compare_none', n: 0 },
      matches > 0 ? { key: 'done', n: matches } : { key: 'done_none', n: 0 }
    ];
  }

  function countDisplayableMatches(jobs, scoreFn) {
    var n = 0;
    (Array.isArray(jobs) ? jobs : []).forEach(function (job) {
      if (!job) return;
      var s = scoreFn(job);
      if (typeof s === 'number' && isFinite(s) && s > 0) n += 1;
    });
    return n;
  }

  return {
    BROWSE_PAGE_SIZE: BROWSE_PAGE_SIZE,
    FEED_WINDOW: FEED_WINDOW,
    KNOWN_FLAGS: KNOWN_FLAGS,
    MAJOR_SKILL_MAP: MAJOR_SKILL_MAP,
    hasMatchableProfile: hasMatchableProfile,
    profilePromptKind: profilePromptKind,
    profileSignals: profileSignals,
    calcMatch: calcMatch,
    displayableScore: displayableScore,
    progressDuration: progressDuration,
    progressAt: progressAt,
    skillChips: skillChips,
    buildProgressSteps: buildProgressSteps,
    countDisplayableMatches: countDisplayableMatches,
    emptyMatch: emptyMatch,
    skillsAlign: skillsAlign,
    skillInText: skillInText,
    stemInText: stemInText,
    isFieldStem: isFieldStem,
    canonicalizeSkill: canonicalizeSkill,
    compareJobs: compareJobs,
    diversifyBySource: diversifyBySource,
    recencyDay: recencyDay,
    isFeatured: isFeatured,
    telegramFeedQuery: telegramFeedQuery,
    mergeFeedRows: mergeFeedRows,
    isTelegramJob: isTelegramJob,
    MESSAGE_KINDS: MESSAGE_KINDS,
    EMPLOYER_EMAIL: EMPLOYER_EMAIL,
    SITE_ORIGIN: SITE_ORIGIN,
    classifyApply: classifyApply,
    maskContacts: maskContacts,
    matchingSkills: matchingSkills,
    buildApplyMessage: buildApplyMessage,
    buildApplyHref: buildApplyHref,
    carryApplyBody: carryApplyBody,
    jobPath: jobPath,
    jobUrl: jobUrl,
    routeUrl: routeUrl,
    parseRoute: parseRoute,
    shareTelegramUrl: shareTelegramUrl,
    employerMailto: employerMailto,
    claimMailto: claimMailto,
    guestSortKey: guestSortKey,
    stableIdRank: stableIdRank,
    publicationDate: publicationDate,
    listingRejectReason: listingRejectReason,
    isStudentSuitable: isStudentSuitable,
    listingEligibleForFeed: listingEligibleForFeed,
    compareFeedWindow: compareFeedWindow,
    jobsFeedQuery: jobsFeedQuery,
    jobsListQuery: jobsListQuery,
    SEARCH_MIN_CHARS: SEARCH_MIN_CHARS,
    SEARCH_THIN_RESULTS: SEARCH_THIN_RESULTS,
    SEARCH_DB_LIMIT: SEARCH_DB_LIMIT,
    sanitizeSearchQuery: sanitizeSearchQuery,
    searchDbQuery: searchDbQuery,
    shouldSearchDatabase: shouldSearchDatabase,
    pluralIndex: pluralIndex,
    mergeSearchResults: mergeSearchResults,
    createRequestGuard: createRequestGuard,
    SEARCH_LOADER_MS: SEARCH_LOADER_MS,
    searchProgressAt: searchProgressAt,
    nbspMoney: nbspMoney,
    telegramListQuery: telegramListQuery,
    takeFeedWindow: takeFeedWindow,
    selectFeedListings: selectFeedListings,
    inferInternship: inferInternship,
    reconcileSalary: reconcileSalary,
    sanitizeSalary: sanitizeSalary,
    parseSalaryFromText: parseSalaryFromText,
    formatSalary: formatSalary,
    paginate: paginate,
    SEEN_ID_CAP: SEEN_ID_CAP,
    normalizeAlertSpec: normalizeAlertSpec,
    alertSpecKey: alertSpecKey,
    alertIsActive: alertIsActive,
    jobMatchesSpec: jobMatchesSpec,
    filterBrowseJobs: filterBrowseJobs,
    matchingJobs: matchingJobs,
    matchingJobIds: matchingJobIds,
    mergeSeenIds: mergeSeenIds,
    newMatchesFor: newMatchesFor,
    consumeAlertMatches: consumeAlertMatches,
    seedAlert: seedAlert,
    canSaveAlert: canSaveAlert,
    applyAlertEdit: applyAlertEdit,
    classifyAlertDispatch: classifyAlertDispatch,
    defaultFlagTests: defaultFlagTests,
    detectIndustry: detectIndustry,
    inferNoExp: inferNoExp,
    inferFlexible: inferFlexible,
    normalizeListing: normalizeListing,
    asArray: asArray
  };
});
