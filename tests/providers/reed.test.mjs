// tests/providers/reed.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — reed');

// Shape captured 2026-10-28 from www.reed.co.uk/jobs/software-engineer-jobs-in-london
// (__NEXT_DATA__ → props.pageProps.searchResults), trimmed and renamed to
// fictional values.
function row(id, over = {}, detail = {}) {
  return {
    hasApplied: false,
    profileName: 'Acme Recruitment',
    profileUrl: 'acme-recruitment',
    url: `/jobs/software-engineer/${id}`,
    ouUrl: '/jobs/acme-recruitment/p1',
    ...over,
    jobDetail: {
      jobId: id,
      jobTitle: 'Software Engineer',
      jobDescriptionSnippet: 'Software Engineer | 50,000 - 60,000 | Remote ...',
      dateCreated: '2026-10-14T10:05:41.337',
      displayLocationName: 'London',
      externalUrl: '',
      ouName: 'Acme Recruitment',
      isTrainingJob: false,
      isPromoted: false,
      ...detail,
    },
  };
}

function page(jobs, count = jobs.length, extra = {}) {
  const data = {
    props: { pageProps: { searchResults: { count, jobs, promotedJobs: [row(999, {}, { jobTitle: 'Promoted Role' })], ...extra } } },
    page: '/jobs/[[...criteria]]',
  };
  return `<!DOCTYPE html><html><head></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function makeCtx(pages, opts = {}) {
  const calls = [];
  const ctx = {
    calls,
    sleep: async () => {},
    fetchText: async (url, o) => {
      calls.push({ url, opts: o });
      if (opts.onFetch) return opts.onFetch(url, calls.length);
      const p = new URL(url).searchParams.get('pageno') || '1';
      const body = pages[`${new URL(url).pathname}#${p}`];
      if (body === undefined) throw Object.assign(new Error('404'), { status: 404 });
      return body;
    },
    ...opts.ctx,
  };
  return ctx;
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/reed.mjs')).href);
  const reed = mod.default;
  const { parseReedPage, parseReedConfig, buildSearchPath, buildPageUrl, searchPathFromUrl, PAGE_SIZE } = mod;

  if (reed.id === 'reed') pass('reed.id is "reed"');
  else fail(`reed.id is ${JSON.stringify(reed.id)}`);

  // ── detect ──
  const explicit = reed.detect({ name: 'Reed', provider: 'reed' });
  if (explicit && explicit.url === 'https://www.reed.co.uk/jobs') pass('detect() claims provider: reed with no careers_url');
  else fail(`detect(provider: reed) returned ${JSON.stringify(explicit)}`);

  const byUrl = reed.detect({ name: 'Reed', careers_url: 'https://www.reed.co.uk/jobs/data-engineer-jobs-in-manchester?sid=abc&pageno=3' });
  if (byUrl && byUrl.url === 'https://www.reed.co.uk/jobs/data-engineer-jobs-in-manchester') pass('detect() claims a reed search URL, dropping its query string');
  else fail(`detect(reed search URL) returned ${JSON.stringify(byUrl)}`);

  const junk = [
    { careers_url: 'http://www.reed.co.uk/jobs/x-jobs' },
    { careers_url: 'https://www.reed.co.uk.evil.example/jobs/x-jobs' },
    { careers_url: 'https://evilreed.co.uk/jobs/x-jobs' },
    { careers_url: 'https://www.reed.co.uk/courses/x' },
    { careers_url: 'not a url' },
    { careers_url: 42 },
    { careers_url: null },
    {},
    null,
    { provider: 'jobbankca' },
  ];
  const leaked = junk.filter((e) => { try { return reed.detect(e) !== null; } catch { return true; } });
  if (leaked.length === 0) pass('detect() returns null (no throw) for untrusted host, http, non-/jobs path, malformed and missing URLs');
  else fail(`detect() claimed or threw on ${JSON.stringify(leaked)}`);

  if (searchPathFromUrl('https://reed.co.uk:8443/jobs/Python-Jobs/') === '/jobs/python-jobs') pass('searchPathFromUrl rebuilds from host + slug path only (port and trailing slash discarded)');
  else fail(`searchPathFromUrl returned ${searchPathFromUrl('https://reed.co.uk:8443/jobs/Python-Jobs/')}`);

  // ── config + URL building ──
  const cfg = parseReedConfig({ reed: { keywords: [' Software Engineer ', '', 42, '!!!', 'Software Engineer'], location: ' London ' } });
  if (JSON.stringify(cfg) === JSON.stringify({ keywords: ['Software Engineer'], location: 'London' })) pass('parseReedConfig trims, dedupes and drops blank/non-string/unsluggable keywords');
  else fail(`parseReedConfig returned ${JSON.stringify(cfg)}`);

  if (buildSearchPath('C++ / Node.js developer', 'Milton Keynes') === '/jobs/c-node-js-developer-jobs-in-milton-keynes'
    && buildSearchPath('Data Engineer') === '/jobs/data-engineer-jobs') pass('buildSearchPath builds Reed slug paths with and without a location');
  else fail(`buildSearchPath returned ${buildSearchPath('C++ / Node.js developer', 'Milton Keynes')} / ${buildSearchPath('Data Engineer')}`);

  if (buildPageUrl('/jobs/x-jobs', 1) === 'https://www.reed.co.uk/jobs/x-jobs'
    && buildPageUrl('/jobs/x-jobs', 3) === 'https://www.reed.co.uk/jobs/x-jobs?pageno=3') pass('buildPageUrl adds ?pageno only past page 1');
  else fail('buildPageUrl did not build the expected URLs');

  // ── parseReedPage ──
  const parsed = parseReedPage(page([
    row(101, {}, { jobTitle: 'Senior R&amp;D Engineer' }),
    row(102, {}, { externalUrl: 'https://careers.example.com/jobs/77' }),
    row(103, {}, { isTrainingJob: true, jobTitle: 'Become a Software Engineer (course)' }),
    row(104, {}, { jobTitle: '' }),
    row(105, { url: 'javascript:alert(1)' }, { jobId: 'x' }),
    row(106, { url: '/jobs/ok/106' }, { dateCreated: 'garbage', ouName: '', externalUrl: 'http://insecure.example.com' }),
    { jobDetail: null },
    null,
  ], 1099));
  const urls = parsed.jobs.map((j) => j.url);
  if (parsed.rawCount === 8 && parsed.total === 1099) pass('parseReedPage reports the raw row count and source total');
  else fail(`parseReedPage rawCount/total = ${parsed.rawCount}/${parsed.total}`);
  if (JSON.stringify(urls) === JSON.stringify([
    'https://www.reed.co.uk/jobs/software-engineer/101',
    'https://careers.example.com/jobs/77',
    'https://www.reed.co.uk/jobs/ok/106',
  ])) pass('parseReedPage keeps valid rows, prefers an https employer externalUrl, drops training/untitled/unaddressable rows');
  else fail(`parseReedPage urls = ${JSON.stringify(urls)}`);
  const first = parsed.jobs[0];
  if (first.title === 'Senior R&D Engineer' && first.company === 'Acme Recruitment' && first.location === 'London' && first.postedAt === Date.parse('2026-10-14T10:05:41.337Z')) pass('parseReedPage maps company, location and a zone-less date read as UTC');
  else fail(`first job = ${JSON.stringify(first)}`);
  if (!parsed.jobs.some((j) => j.title === 'Promoted Role')) pass('parseReedPage ignores promotedJobs[] (paid placement)');
  else fail('parseReedPage read promotedJobs[]');
  const j106 = parsed.jobs[2];
  if (j106.company === 'Acme Recruitment' && !('postedAt' in j106)) pass('parseReedPage falls back to profileName and omits an unparseable date');
  else fail(`job 106 = ${JSON.stringify(j106)}`);

  const empty = parseReedPage(page([], 0));
  if (empty.jobs.length === 0 && empty.rawCount === 0) pass('parseReedPage: a present-and-empty jobs[] is an empty search');
  else fail('parseReedPage should return [] for an empty jobs[]');

  const broken = [
    ['no __NEXT_DATA__', '<html><body>Just a moment...</body></html>'],
    ['unparseable JSON', '<script id="__NEXT_DATA__" type="application/json">{nope</script>'],
    ['missing searchResults', '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'],
    ['jobs not an array', '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"searchResults":{"jobs":{}}}}}</script>'],
  ];
  for (const [label, html] of broken) {
    try { parseReedPage(html); fail(`parseReedPage should throw on ${label}`); }
    catch (err) {
      if (/^reed: /.test(err.message)) pass(`parseReedPage throws a descriptive error on ${label}`);
      else fail(`parseReedPage threw an undescriptive error on ${label}: ${err.message}`);
    }
  }

  // ── fetch: pagination, redirect:'error', dedup ──
  const full = (start) => Array.from({ length: PAGE_SIZE }, (_, i) => row(start + i));
  {
    const ctx = makeCtx({
      '/jobs/software-engineer-jobs-in-london#1': page(full(1000), 60),
      '/jobs/software-engineer-jobs-in-london#2': page(full(2000), 60),
      '/jobs/software-engineer-jobs-in-london#3': page([row(3000), row(1000)], 60),
    });
    const jobs = await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['software engineer'], location: 'London' } }, ctx);
    if (jobs.length === 51 && ctx.calls.length === 3) pass('fetch walks pages until the short final page and dedupes by URL');
    else fail(`fetch returned ${jobs.length} jobs over ${ctx.calls.length} calls`);
    if (ctx.calls.every((c) => c.opts && c.opts.redirect === 'error')) pass('fetch passes redirect: "error" on every request');
    else fail('fetch issued a request without redirect: "error"');
  }

  {
    const ctx = makeCtx({}, { onFetch: (url) => page(full(Number(new URL(url).searchParams.get('pageno') || 1) * 1000), 5000) });
    const errs = [];
    const orig = console.error;
    console.error = (m) => errs.push(String(m));
    try { await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['x'] } }, ctx); }
    finally { console.error = orig; }
    if (ctx.calls.length === 10) pass('fetch stops at its own DEFAULT_MAX_PAGES (10) even when the source reports more');
    else fail(`fetch made ${ctx.calls.length} calls with a 5000-result board`);
    if (errs.some((m) => /raise max_pages/.test(m))) pass('fetch warns "raise max_pages" when the ceiling truncates a full board');
    else fail('fetch did not warn on a ceiling truncation');

    const ctx2 = makeCtx({}, { onFetch: () => page(full(1), 5000) });
    console.error = () => {};
    try { await reed.fetch({ name: 'Reed', provider: 'reed', max_pages: 9999, reed: { keywords: ['x'] } }, ctx2); }
    finally { console.error = orig; }
    if (ctx2.calls.length === 60) pass('a configured max_pages is clamped to MAX_PAGES_CAP (60)');
    else fail(`max_pages: 9999 made ${ctx2.calls.length} calls`);
  }

  {
    const ctx = makeCtx({}, { onFetch: (url, n) => {
      if (n >= 3) throw Object.assign(new Error('503'), { status: 503 });
      return page(full(n * 1000), 5000);
    } });
    const errs = [];
    const orig = console.error;
    console.error = (m) => errs.push(String(m));
    let jobs;
    try { jobs = await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['x'] } }, ctx); }
    finally { console.error = orig; }
    if (jobs.length === 50) pass('a page that exhausts retry keeps the pages already collected');
    else fail(`fetch-error stop returned ${jobs.length} jobs`);
    if (!errs.some((m) => /raise max_pages/.test(m))) pass('a fetch-error stop does not fire the "raise max_pages" warning');
    else fail('a fetch-error stop fired the max_pages warning');
  }

  {
    const ctx = makeCtx({}, { onFetch: () => { throw Object.assign(new Error('403'), { status: 403 }); } });
    try { await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['a', 'b'] } }, ctx); fail('fetch should throw when every search fails'); }
    catch (err) {
      if (/reed: all 2 search\(es\) failed/.test(err.message)) pass('fetch throws when every search\'s first page fails');
      else fail(`unexpected error: ${err.message}`);
    }
  }

  {
    const ctx = makeCtx({
      '/jobs/data-engineer-jobs-in-manchester#1': page(full(1), 500),
    }, { ctx: { maxPages: 1 } });
    await reed.fetch({ name: 'Reed', careers_url: 'https://www.reed.co.uk/jobs/data-engineer-jobs-in-manchester' }, ctx);
    if (ctx.calls.length === 1) pass('probe (ctx.maxPages: 1) issues exactly one list request');
    else fail(`probe issued ${ctx.calls.length} requests`);

    class Budget extends Error {}
    const sentinel = new Budget('budget');
    const ctx2 = makeCtx({}, { onFetch: () => { throw sentinel; }, ctx: { maxPages: 1 } });
    try { await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['x'] } }, ctx2); fail('probe should propagate the fetch rejection'); }
    catch (err) {
      if (err === sentinel) pass('a ctx.fetch rejection during a probe propagates unwrapped');
      else fail(`probe rewrapped the rejection: ${err && err.message}`);
    }
  }

  {
    const ctx = makeCtx({}, { onFetch: () => page([row(1, {}, { jobTitle: 'Sales &amp; Marketing Lead' })], 1) });
    const jobs = await reed.fetch({ name: 'Reed', provider: 'reed', reed: { keywords: ['sales'] } }, ctx);
    if (jobs[0] && jobs[0].title === 'Sales & Marketing Lead') pass('an HTML entity in a title is decoded before the title filter sees it');
    else fail(`title = ${jobs[0] && jobs[0].title}`);
  }
} catch (err) {
  fail(`reed provider tests crashed: ${err && err.stack || err}`);
}
