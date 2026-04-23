import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

chromium.use(stealth());

const CONFIG = {
  // TopDev serves job list via backend API. The website (Next.js CSR) calls this
  // same endpoint internally — calling it directly is faster and gives us the
  // full job detail (content, requirements, benefits) in the list response,
  // so we don't need a separate detail-fetch phase.
  apiBase: 'https://api.topdev.vn/td/v2/jobs/search/v2',
  apiFields: {
    job: 'id,title,salary,slug,company,expires,extra_skills,skills_str,skills_arr,skills_ids,job_types_str,job_levels_str,job_levels_arr,job_levels_ids,addresses,status_display,detail_url,job_url,salary,published,refreshed,applied,candidate,requirements_arr,packages,benefits,content,features,contract_types_ids,is_free,is_basic,is_basic_plus,is_distinction,level,contract_types_str,experiences_str,benefits_v2,services,job_category_id,responsibilities_original,requirements_original,benefits_original',
    company: 'tagline,addresses,skills_arr,industries_arr,industries_ids,industries_str,image_cover,image_galleries,num_job_openings,company_size,nationalities_str,skills_str,skills_ids,benefits,num_employees',
  },
  locale: 'vi_VN',
  referer: 'https://topdev.vn/jobs/search',
  // API default is 15 but honors `page_size` up to at least 1000.
  pageSize: 1000,

  maxPages: null,
  outputFile: 'topdev-jobs.json',
  cookiesFile: 'topdev-cookies.json',
  stateFile: 'topdev-state.json',
  headless: true,
  saveEvery: 5,
  pageDelayMs: [800, 2000],
};

const STATE_VERSION = 2;

const sleep = (min, max = min) => new Promise(r =>
  setTimeout(r, min + Math.random() * (max - min))
);

// ============ HTML CLEANUP ============

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
  '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘', '&rdquo;': '”', '&ldquo;': '“',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, m => HTML_ENTITIES[m.toLowerCase()] ?? m);
}

// Turn TopDev's rich-text HTML into bullet-list plain text.
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  const items = [];
  const liMatches = html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
  if (liMatches && liMatches.length) {
    for (const li of liMatches) {
      const inner = li.replace(/<li[^>]*>|<\/li>/gi, '');
      const txt = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (txt) items.push('- ' + txt);
    }
    return items.join('\n');
  }
  // No <li>: fall back to paragraph-ish split
  const txt = decodeEntities(html.replace(/<\/?(p|div|br)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
  return txt.split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ============ API ============

function buildApiUrl(pageNum) {
  const params = new URLSearchParams();
  params.set('page', String(pageNum));
  params.set('page_size', String(CONFIG.pageSize));
  params.set('fields[job]', CONFIG.apiFields.job);
  params.set('fields[company]', CONFIG.apiFields.company);
  params.set('locale', CONFIG.locale);
  return `${CONFIG.apiBase}?${params.toString()}`;
}

async function fetchJobsPage(requestCtx, pageNum) {
  const url = buildApiUrl(pageNum);
  const res = await requestCtx.get(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://topdev.vn',
      Referer: CONFIG.referer,
    },
    timeout: 90000,
  });
  if (!res.ok()) {
    throw new Error(`API HTTP ${res.status()} for page ${pageNum}`);
  }
  const json = await res.json();
  if (!json || !Array.isArray(json.data)) {
    throw new Error(`API response missing data[] for page ${pageNum}`);
  }
  return json;
}

// ============ TRANSFORM ============

function normalizeJob(raw) {
  const url = raw.detail_url || (raw.slug ? `https://topdev.vn/detail-jobs/${raw.slug}-${raw.id}` : '');

  const salary = raw.salary || {};
  const salaryStr = salary.is_negotiable === '1' || salary.is_negotiable === 1
    ? 'Negotiable'
    : (salary.value || '').replace(/\s+/g, ' ').trim();

  const addr = raw.addresses || {};
  const locations = Array.isArray(addr.address_region_array) ? addr.address_region_array : [];
  const streets = Array.isArray(addr.collection_addresses)
    ? addr.collection_addresses.map(a => a?.street).filter(Boolean)
    : [];

  const tags = [];
  if (Array.isArray(raw.skills_arr)) tags.push(...raw.skills_arr.filter(Boolean));
  if (!tags.length && raw.skills_str) {
    tags.push(...raw.skills_str.split(/[,;]/).map(s => s.trim()).filter(Boolean));
  }

  const responsibilities = htmlToText(raw.responsibilities_original || raw.content || '');
  const requirements = htmlToText(raw.requirements_original || '');
  const benefitsParts = [];
  if (Array.isArray(raw.benefits_v2)) {
    for (const b of raw.benefits_v2) {
      const piece = htmlToText(b?.description || '');
      if (piece) benefitsParts.push(b?.name ? `${b.name}:\n${piece}` : piece);
    }
  }
  if (!benefitsParts.length && raw.benefits_original) {
    benefitsParts.push(htmlToText(raw.benefits_original));
  }

  return {
    id: raw.id,
    slug: raw.slug || '',
    title: (raw.title || '').trim(),
    url,
    company: raw.company?.display_name || '',
    companyUrl: raw.company?.detail_url || '',
    companySize: raw.company?.company_size || '',
    salary: salaryStr,
    salaryRange: {
      min: salary.min_filter ?? null,
      max: salary.max_filter ?? null,
      currency: salary.currency || '',
      unit: salary.unit || '',
    },
    locations,
    addresses: streets,
    jobTypes: raw.job_types_str || '',
    jobLevels: raw.job_levels_str || '',
    experience: raw.experiences_str || '',
    contractTypes: raw.contract_types_str || '',
    tags,
    industries: raw.company?.industries_arr || [],
    jobDescription: responsibilities,
    requirements,
    benefits: benefitsParts.join('\n\n').trim(),
    published: raw.published || '',
    refreshed: raw.refreshed || '',
    expires: raw.expires || '',
    scrapedAt: new Date().toISOString(),
  };
}

// ============ BROWSER (warm-up for CF cookies) ============

async function setupBrowser() {
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    extraHTTPHeaders: {
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    },
  };

  if (fs.existsSync(CONFIG.cookiesFile)) {
    contextOptions.storageState = CONFIG.cookiesFile;
    console.log('📂 Loaded cookies từ file');
  }

  const context = await browser.newContext(contextOptions);
  return { browser, context };
}

async function warmUp(context) {
  const page = await context.newPage();
  try {
    await page.goto('https://topdev.vn/jobs/search', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    if (title.includes('Just a moment') || title.includes('Cloudflare')) {
      console.log('🛑 Cloudflare challenge, đợi 15s...');
      await sleep(15000);
      try {
        await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 30000 });
      } catch {
        console.log('⚠️ Cloudflare vẫn chưa qua, API call có thể fail');
      }
    }
    await sleep(1500, 2500);
  } finally {
    await page.close();
  }
}

// ============ STATE ============

function createInitialState() {
  return {
    version: STATE_VERSION,
    totalPages: 0,
    total: 0,
    perPage: 0,
    completedPages: [],
    jobsById: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    if (s.version !== STATE_VERSION) {
      console.log(`⚠️ State version mismatch (${s.version} vs ${STATE_VERSION}), start fresh`);
      return null;
    }
    return s;
  } catch (err) {
    console.log(`⚠️ State file corrupt (${err.message}), start fresh`);
    return null;
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const tmp = CONFIG.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CONFIG.stateFile);
}

// ============ MAIN ============

async function main() {
  console.time('⏱️ Total time');

  let state = loadState();
  const resuming = !!state;
  if (resuming) {
    console.log(`📂 Resuming: ${state.completedPages.length}/${state.totalPages || '?'} pages, ${Object.keys(state.jobsById).length} jobs`);
  } else {
    state = createInitialState();
    console.log('🆕 Fresh scrape (no state file)');
  }

  const { browser, context } = await setupBrowser();

  let shuttingDown = false;
  const gracefulExit = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n⚠️ Got ${signal}, saving state...`);
    try { saveState(state); } catch (err) { console.error('State save fail:', err.message); }
    try { await context.storageState({ path: CONFIG.cookiesFile }); } catch {}
    try { await browser.close(); } catch {}
    console.log('💾 State saved. Re-run scraper để resume.');
    process.exit(130);
  };
  process.on('SIGINT', () => gracefulExit('SIGINT'));
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));

  console.log('🏠 Warming up browser (Cloudflare + cookies)...');
  await warmUp(context);

  // Probe page 1 to learn totalPages
  if (!state.totalPages) {
    console.log('📊 Fetching page 1 metadata...');
    const first = await fetchJobsPage(context.request, 1);
    state.total = first.meta?.total || 0;
    state.perPage = first.meta?.per_page || first.data.length;
    state.totalPages = first.meta?.last_page || 1;
    if (CONFIG.maxPages) state.totalPages = Math.min(state.totalPages, CONFIG.maxPages);
    // Save page 1 jobs immediately
    for (const raw of first.data) {
      const job = normalizeJob(raw);
      if (job.id != null) state.jobsById[job.id] = job;
    }
    state.completedPages.push(1);
    saveState(state);
    console.log(`📊 Total: ${state.total} jobs across ${state.totalPages} pages (${state.perPage}/page)`);
    console.log(`  ✓ Page 1: got ${first.data.length} jobs`);
  }

  const completedSet = new Set(state.completedPages);
  let pagesSinceSave = 0;

  for (let p = 2; p <= state.totalPages; p++) {
    if (shuttingDown) break;
    if (completedSet.has(p)) continue;

    try {
      const resp = await fetchJobsPage(context.request, p);
      for (const raw of resp.data) {
        const job = normalizeJob(raw);
        if (job.id != null) state.jobsById[job.id] = job;
      }
      state.completedPages.push(p);
      pagesSinceSave++;
      console.log(`  ✓ Page ${p}/${state.totalPages}: got ${resp.data.length} (total unique: ${Object.keys(state.jobsById).length})`);
    } catch (err) {
      console.error(`  ❌ Page ${p} failed: ${err.message}`);
    }

    if (pagesSinceSave >= CONFIG.saveEvery) {
      saveState(state);
      pagesSinceSave = 0;
    }
    if (p % 20 === 0) {
      try { await context.storageState({ path: CONFIG.cookiesFile }); } catch {}
    }
    await sleep(CONFIG.pageDelayMs[0], CONFIG.pageDelayMs[1]);
  }

  saveState(state);

  const doneSet = new Set(state.completedPages);
  const failed = [];
  for (let p = 1; p <= state.totalPages; p++) if (!doneSet.has(p)) failed.push(p);
  if (failed.length) {
    console.log(`\n⚠️ ${failed.length} page(s) chưa xong: [${failed.slice(0, 20).join(',')}${failed.length > 20 ? ',...' : ''}]. Re-run để retry.`);
  }

  try { await context.storageState({ path: CONFIG.cookiesFile }); } catch {}
  await browser.close();

  const jobs = Object.values(state.jobsById);
  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(jobs, null, 2));
  console.log(`\n✅ Saved ${jobs.length} jobs to ${CONFIG.outputFile}`);
  console.timeEnd('⏱️ Total time');
}

main().catch(err => {
  console.error('💥 Fatal:', err);
  console.log('ℹ️ State đã save. Re-run để resume.');
  process.exit(1);
});
