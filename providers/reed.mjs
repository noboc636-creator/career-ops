// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// Reed provider — reed.co.uk, a UK general job board (many employers and
// recruitment agencies). A `job_boards:` entry, reached with an explicit
// `provider: reed` or a `careers_url` on www.reed.co.uk:
//
//   - name: Reed — Software
//     provider: reed
//     reed:
//       # keywords optional: falls back to config/profile.yml's target_roles
//       # (primary[] + archetypes[].name) when omitted, same as vdab.mjs.
//       keywords: ["software engineer", "backend developer"]
//       location: london        # optional; omit for the whole UK
//     enabled: true
//
//   - name: Reed — saved search
//     careers_url: https://www.reed.co.uk/jobs/data-engineer-jobs-in-manchester
//     enabled: true
//
// SOURCE. The search results page (`/jobs/{keywords}-jobs[-in-{location}]`) is
// a Next.js page that server-renders the whole result page into __NEXT_DATA__
// at props.pageProps.searchResults: `count` (total matches) and `jobs[]` (25
// per page), each `{ url, profileName, jobDetail: { jobId, jobTitle, ouName,
// displayLocationName, dateCreated, externalUrl, isTrainingJob, ... } }`.
// Measured 2026-10-28 on /jobs/software-engineer-jobs-in-london: 25 jobs on
// page 1, count 1099. `?pageno=N` is the page parameter the page's own
// pagination links carry. `promotedJobs[]` (paid placement) is a separate
// list and is not read — rule 3, complete organic inventory.
//
// Reed's official API (/api/1.0/search) needs a registered API key, and
// robots.txt disallows `/api/` for every agent, so this reads the public HTML
// page any visitor sees instead.
//
// robots.txt (fetched 2026-10-28), `User-agent: *` group: disallows `/api/`,
// `/jobs/*?*sortBy=`, `/*?sourceInternal=`, `/*multipleParentSectorIds=`,
// none of which this provider requests. No Crawl-delay for `*`.
//
// `isTrainingJob` rows are paid course adverts presented as jobs (the page's
// own "hide training jobs" toggle filters on the same flag) and are dropped.
// `externalUrl`, when set, is the employer's own application link and wins
// over the Reed page per rule 2.

import { fetchTextWithRetry, BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const ORIGIN = 'https://www.reed.co.uk';
const TRUSTED_HOSTS = new Set(['www.reed.co.uk', 'reed.co.uk']);

/** Measured page size; a shorter page is the end of the results. */
export const PAGE_SIZE = 25;

/** Pages per search when the entry sets no max_pages (250 postings). */
const DEFAULT_MAX_PAGES = 10;

/** Hard ceiling on a configured max_pages, whatever `count` says. */
const MAX_PAGES_CAP = 60;

/** No Crawl-delay is stated; the project's usual inter-page pacing. */
const INTER_PAGE_DELAY_MS = 250;

/** Lowercase, non-alphanumerics collapsed to `-` — the form Reed's own search URLs use. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reads and sanitizes the entry's `reed:` config block.
 * @param {{ reed?: any }} entry
 * @returns {{ keywords: string[], location: string }}
 */
export function parseReedConfig(entry) {
  const cfg = (entry && entry.reed) || {};
  const keywords = Array.isArray(cfg.keywords)
    ? [...new Set(cfg.keywords.filter((k) => typeof k === 'string' && slugify(k)).map((k) => k.trim()))]
    : [];
  const location = typeof cfg.location === 'string' ? cfg.location.trim() : '';
  return { keywords, location };
}

/**
 * The search path for a keyword (and optional location).
 * @param {string} keyword @param {string} [location]
 */
export function buildSearchPath(keyword, location = '') {
  const kw = slugify(keyword);
  if (!kw) throw new Error(`reed: keyword ${JSON.stringify(keyword)} has no searchable characters`);
  const loc = slugify(location);
  return loc ? `/jobs/${kw}-jobs-in-${loc}` : `/jobs/${kw}-jobs`;
}

/** @param {string} path @param {number} page */
export function buildPageUrl(path, page) {
  return page > 1 ? `${ORIGIN}${path}?pageno=${page}` : `${ORIGIN}${path}`;
}

/**
 * A Reed `careers_url` → its search path, or null. Only the host is a trust
 * boundary; the path is kept only when it is a plain `/jobs/...` slug path
 * (query string, port and fragment are discarded, and the origin is rebuilt).
 * @param {unknown} raw
 */
export function searchPathFromUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return /^\/jobs\/[a-z0-9-]+$/i.test(path) ? path.toLowerCase() : null;
}

function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  // Reed's timestamps carry no zone ("2026-10-14T10:05:41.337"); read as UTC
  // rather than the scanner machine's local time.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

// Recruiter-typed fields can carry HTML entities ("R&amp;D") even inside the
// JSON blob; decode before the title filter sees them (#2923).
function text(value) {
  return typeof value === 'string' ? decodeEntities(value).trim() : '';
}

/** @param {any} row @returns {Job | null} */
function normalizeRow(row) {
  const d = row && typeof row === 'object' ? row.jobDetail : null;
  if (!d || typeof d !== 'object' || d.isTrainingJob === true) return null;
  const title = text(d.jobTitle);
  if (!title) return null;

  let reedUrl = '';
  if (typeof row.url === 'string' && /^\/jobs\/[^/?#\s]+\/\d+$/.test(row.url)) {
    reedUrl = `${ORIGIN}${row.url}`;
  } else if (d.jobId != null) {
    const id = safeEncodeURIComponent(String(d.jobId));
    const slug = slugify(title) || 'job';
    if (id !== null && /^\d+$/.test(id)) reedUrl = `${ORIGIN}/jobs/${slug}/${id}`;
  }
  const url = httpsUrl(d.externalUrl) || reedUrl;
  if (!url) return null;

  const company = [d.ouName, row.profileName].find((v) => typeof v === 'string' && v.trim());
  /** @type {Job} */
  const job = {
    title,
    url,
    company: text(company),
    location: text(d.displayLocationName),
  };
  const postedAt = toEpochMs(d.dateCreated);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/**
 * Parse one Reed results page. Exported for unit tests.
 * Throws when the page is not the documented shape (markup change); an
 * empty `jobs[]` is a search with no results.
 * @param {string} html
 * @returns {{ jobs: Job[], rawCount: number, total: number | null }}
 */
export function parseReedPage(html) {
  const m = String(html ?? '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('reed: results page has no __NEXT_DATA__ (markup changed, or a bot challenge page)');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`reed: failed to parse __NEXT_DATA__ — ${(err && err.message) || err}`);
  }
  const sr = data?.props?.pageProps?.searchResults;
  const rows = sr && Array.isArray(sr.jobs) ? sr.jobs : null;
  if (!rows) {
    const got = sr && typeof sr === 'object' ? Object.keys(sr).join(', ') : typeof sr;
    throw new Error(`reed: unexpected __NEXT_DATA__ — expected props.pageProps.searchResults.jobs[], got: [${got}]`);
  }
  const jobs = [];
  for (const row of rows) {
    const job = normalizeRow(row);
    if (job) jobs.push(job);
  }
  const total = Number.isInteger(sr.count) && sr.count >= 0 ? sr.count : null;
  return { jobs, rawCount: rows.length, total };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'reed',

  detect(entry) {
    if (entry?.provider === 'reed') return { url: `${ORIGIN}/jobs` };
    const path = searchPathFromUrl(entry?.careers_url);
    return path ? { url: `${ORIGIN}${path}` } : null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || '(unnamed)';
    /** @type {string[]} */
    let paths;
    const urlPath = searchPathFromUrl(entry?.careers_url);
    if (urlPath) {
      paths = [urlPath];
    } else {
      let { keywords, location } = parseReedConfig(entry);
      if (!keywords.length) keywords = resolveProfileKeywords().filter((k) => slugify(k));
      if (!keywords.length) {
        throw new Error(`reed: entry "${name}" has no reed.keywords[], no www.reed.co.uk careers_url, and no config/profile.yml target_roles to fall back to`);
      }
      paths = [...new Set(keywords.map((k) => buildSearchPath(k, location)))];
    }

    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const maxPages = probing ? Math.min(ctx.maxPages, resolveMaxPages(entry)) : resolveMaxPages(entry);

    /** @type {Map<string, Job>} */
    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;

    for (const path of paths) {
      /** @type {'complete' | 'cap' | 'fetch-error'} */
      let stopReason = 'complete';
      let page = 1;
      for (; page <= maxPages; page++) {
        if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
        let html;
        try {
          html = await fetchTextWithRetry(ctx, buildPageUrl(path, page), {
            headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT },
            redirect: 'error',
          });
        } catch (err) {
          // A probe must see the budget sentinel unwrapped (verify-portals).
          if (probing) throw err;
          if (page === 1) errors.push(`${path}: ${(err && err.message) || err}`);
          else console.error(`⚠️  reed: ${name} ${path} stopped at page ${page} on a fetch error — keeping ${page - 1} page(s)`);
          stopReason = 'fetch-error';
          break;
        }
        const { jobs, rawCount, total } = parseReedPage(html);
        if (page === 1) succeeded++;
        for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        if (rawCount < PAGE_SIZE) break;
        if (total !== null && page * PAGE_SIZE >= total) break;
        if (page === maxPages) stopReason = 'cap';
      }
      if (stopReason === 'cap' && !probing) {
        console.error(`⚠️  reed: ${name} ${path} truncated at max_pages=${maxPages} — raise max_pages on this entry for more`);
      }
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`reed: all ${paths.length} search(es) failed — ${errors[0]}`);
    }
    return [...byUrl.values()];
  },
};
