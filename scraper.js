import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs';
import pLimit from 'p-limit';

chromium.use(stealth());

const CONFIG = {
  baseUrl: 'https://topdev.vn/viec-lam-it',
  maxPages: null,
  outputFile: 'topdev-jobs.json',
  cookiesFile: 'topdev-cookies.json',
  stateFile: 'topdev-state.json',
  headless: true,
  detailConcurrency: 2,
  saveEvery: 5,
  // TopDev dùng Next.js CSR; cần chờ render xong trước khi parse.
  renderWaitMs: 2500,
  // Scroll-to-bottom để trigger lazy load (nếu page có infinite scroll).
  scrollToBottom: true,
};

const STATE_VERSION = 1;

const sleep = (min, max = min) => new Promise(r =>
  setTimeout(r, min + Math.random() * (max - min))
);

// ============ PARSE HTML FUNCTIONS ============
//
// ⚠️ TODO — selectors dưới đây là placeholder. TopDev structure khác ITviec
// và chỉ render sau khi JS load. Sau lần chạy đầu, inspect debug-page1.html
// (tự động dump) để tìm:
//   - Container của từng job card (vd: article, li, div[class*="job"])
//   - Selector cho title, company, salary, location, tags, link detail
//   - URL pattern của detail page (/viec-lam/<slug>? /jobs/<id>?)
// Rồi cập nhật 2 hàm dưới.

function parseJobList(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  // TODO: thay selector sau khi inspect
  $('[class*="job-card"], [class*="JobCard"], article[class*="job"], li[class*="job"]').each((_, el) => {
    const $el = $(el);

    // TODO: title + URL
    const $titleLink = $el.find('a[href*="/viec-lam"], a[href*="/jobs"], a[href*="/job"]').first();
    const href = $titleLink.attr('href') || '';
    const title = $titleLink.text().trim() || $el.find('h3, h2').first().text().trim();
    if (!title || !href) return;

    const url = href.startsWith('http') ? href : 'https://topdev.vn' + href;
    const slug = (url.match(/\/(?:viec-lam|jobs|job)\/([^/?#]+)/) || [])[1] || '';

    // TODO: các field còn lại
    const company = $el.find('[class*="company"], [class*="Company"]').first().text().trim();
    const salary = $el.find('[class*="salary"], [class*="Salary"]').first().text().replace(/\s+/g, ' ').trim();
    const location = $el.find('[class*="location"], [class*="Location"]').first().text().trim();
    const tags = $el.find('[class*="tag"], [class*="Tag"], [class*="skill"], [class*="Skill"]')
      .map((_, t) => $(t).text().trim()).get()
      .filter(t => t && t.length < 40);

    jobs.push({
      slug,
      title,
      url,
      company,
      salary: salary || '',
      location,
      tags,
    });
  });

  return jobs;
}

function parseJobDetail(html, baseData) {
  const $ = cheerio.load(html);

  // TODO: adjust sau khi inspect detail page HTML
  const title = $('h1').first().text().trim() || baseData.title;

  // Section extraction tương tự ITviec — tuỳ DOM TopDev
  const sectionMap = {};
  $('h2, h3').each((_, h) => {
    const heading = $(h).text().trim();
    if (!heading) return;
    let sib = $(h).next();
    const chunks = [];
    while (sib.length && !/^(H2|H3)$/.test(sib[0].tagName?.toUpperCase() || '')) {
      const lis = sib.find('li');
      if (lis.length) {
        chunks.push(lis.map((_, li) => '- ' + $(li).text().trim().replace(/\s+/g, ' ')).get().join('\n'));
      } else {
        const t = sib.text().trim().replace(/\s+/g, ' ');
        if (t) chunks.push(t);
      }
      sib = sib.next();
    }
    sectionMap[heading] = chunks.join('\n\n').trim();
  });

  return {
    ...baseData,
    title,
    jobDescription: sectionMap['Job Description'] || sectionMap['Mô tả công việc'] || '',
    requirements: sectionMap['Requirements'] || sectionMap['Yêu cầu'] || '',
    benefits: sectionMap['Benefits'] || sectionMap['Quyền lợi'] || '',
    scrapedAt: new Date().toISOString(),
  };
}

// ============ SCRAPE FLOW ============

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

async function bypassCloudflare(page) {
  const title = await page.title();
  if (title.includes('Just a moment') || title.includes('Cloudflare')) {
    console.log('🛑 Cloudflare challenge, đợi 15s...');
    await sleep(15000);
    try {
      await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 30000 });
    } catch {
      console.log('⚠️ Cloudflare challenge chưa qua, tiếp tục...');
    }
  }
}

// Scroll-to-bottom nhiều lần để trigger lazy-load (infinite scroll)
async function autoScroll(page, maxScrolls = 10) {
  for (let i = 0; i < maxScrolls; i++) {
    const prevHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800, 1500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break; // không còn content mới
  }
  // Back to top để detail card hiển thị bình thường
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function detectTotalPages(page) {
  // TODO: TopDev có thể dùng pagination page=N hoặc infinite scroll.
  // Nếu pagination link → extract max page. Nếu không → return 1 và dùng scroll.
  const total = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="page="]');
    let max = 1;
    for (const link of links) {
      const m = link.href.match(/page=(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1]));
    }
    return max;
  });
  return total;
}

async function scrapeListPage(page, pageNum) {
  const url = pageNum > 1 ? `${CONFIG.baseUrl}?page=${pageNum}` : CONFIG.baseUrl;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await bypassCloudflare(page);

  // Chờ JS render (TopDev là Next.js CSR)
  await sleep(CONFIG.renderWaitMs);

  if (CONFIG.scrollToBottom) {
    await autoScroll(page);
  }

  const html = await page.content();

  // Dump page 1 để inspect selectors
  if (pageNum === 1 && !fs.existsSync('debug-page1.html')) {
    fs.writeFileSync('debug-page1.html', html);
    console.log('  💾 Saved debug-page1.html — inspect để tìm selector thật');
  }

  return parseJobList(html);
}

async function scrapeJobDetail(context, job) {
  const page = await context.newPage();
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bypassCloudflare(page);
    await sleep(CONFIG.renderWaitMs);
    const html = await page.content();
    return parseJobDetail(html, job);
  } finally {
    await page.close();
  }
}

// ============ STATE / RESUME ============

function createInitialState() {
  return {
    version: STATE_VERSION,
    phase: 'list',
    totalPages: 0,
    allJobs: [],
    completedPages: [],
    detailed: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    if (s.version !== STATE_VERSION) {
      console.log(`⚠️ State version mismatch, start fresh`);
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
    const detailDone = Object.keys(state.detailed).length;
    console.log(`📂 Resuming: phase=${state.phase}, list ${state.completedPages.length}/${state.totalPages || '?'}, detail ${detailDone}/${state.allJobs.length}`);
  } else {
    state = createInitialState();
    console.log('🆕 Fresh scrape (no state file)');
  }

  if (state.phase === 'done') {
    const finalJobs = Object.values(state.detailed);
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(finalJobs, null, 2));
    console.log(`✅ State done. Re-saved ${finalJobs.length} jobs → ${CONFIG.outputFile}`);
    console.log(`ℹ️ Delete ${CONFIG.stateFile} to scrape again.`);
    console.timeEnd('⏱️ Total time');
    return;
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

  const page = await context.newPage();

  if (!resuming) {
    console.log('🏠 Visiting homepage...');
    await page.goto('https://topdev.vn/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bypassCloudflare(page);
    await sleep(2000, 4000);
  }

  if (!state.totalPages) {
    console.log('📊 Detecting total pages...');
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bypassCloudflare(page);
    await sleep(CONFIG.renderWaitMs);

    let totalPages = await detectTotalPages(page);
    if (CONFIG.maxPages) totalPages = Math.min(totalPages, CONFIG.maxPages);
    state.totalPages = totalPages;
    saveState(state);
  }
  console.log(`📊 Total pages: ${state.totalPages}`);

  if (state.phase === 'list') {
    const completedSet = new Set(state.completedPages);
    const seenUrls = new Set(state.allJobs.map(j => j.url));

    for (let p = 1; p <= state.totalPages; p++) {
      if (completedSet.has(p)) continue;
      console.log(`\n📄 Page ${p}/${state.totalPages}`);
      try {
        const jobs = await scrapeListPage(page, p);
        const newJobs = jobs.filter(j => !seenUrls.has(j.url));
        newJobs.forEach(j => seenUrls.add(j.url));
        state.allJobs.push(...newJobs);
        state.completedPages.push(p);
        saveState(state);
        console.log(`  ✓ Got ${jobs.length} (${newJobs.length} new, total: ${state.allJobs.length})`);
      } catch (err) {
        console.error(`  ❌ Page ${p} failed: ${err.message}`);
      }

      if (p % 5 === 0) await context.storageState({ path: CONFIG.cookiesFile });
      await sleep(1500, 3500);
    }

    const doneSet = new Set(state.completedPages);
    const failed = [];
    for (let p = 1; p <= state.totalPages; p++) if (!doneSet.has(p)) failed.push(p);
    if (failed.length) {
      console.log(`\n⚠️ ${failed.length} page(s) failed: [${failed.join(',')}]. Re-run to retry.`);
      await page.close();
      await context.storageState({ path: CONFIG.cookiesFile });
      await browser.close();
      console.timeEnd('⏱️ Total time');
      return;
    }

    state.phase = 'detail';
    saveState(state);
  }

  await page.close();
  console.log(`\n📊 Total jobs collected: ${state.allJobs.length}`);

  if (state.phase === 'detail') {
    const todo = state.allJobs.filter(j => !state.detailed[j.url]);
    const alreadyDone = state.allJobs.length - todo.length;
    console.log(`\n🔍 Scraping ${todo.length} details (${alreadyDone} already done)`);

    const limit = pLimit(CONFIG.detailConcurrency);
    let done = 0, lastSaveAt = 0;

    const tasks = todo.map(job => limit(async () => {
      if (shuttingDown) return;
      try {
        await sleep(800, 2000);
        const detail = await scrapeJobDetail(context, job);
        state.detailed[job.url] = detail;
      } catch (err) {
        console.error(`  ❌ ${job.title.slice(0, 40)}: ${err.message}`);
        state.detailed[job.url] = job;
      }
      done++;
      if (done - lastSaveAt >= CONFIG.saveEvery) {
        saveState(state);
        lastSaveAt = done;
      }
      if (done % 10 === 0) {
        console.log(`  Progress: ${done}/${todo.length}`);
      }
    }));

    await Promise.all(tasks);
    saveState(state);
    state.phase = 'done';
    saveState(state);
  }

  await context.storageState({ path: CONFIG.cookiesFile });
  await browser.close();

  const finalJobs = Object.values(state.detailed);
  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(finalJobs, null, 2));
  console.log(`\n✅ Saved ${finalJobs.length} jobs to ${CONFIG.outputFile}`);
  console.timeEnd('⏱️ Total time');
}

main().catch(err => {
  console.error('💥 Fatal:', err);
  console.log('ℹ️ State đã save. Re-run để resume.');
  process.exit(1);
});
