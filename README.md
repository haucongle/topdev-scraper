# TopDev Scraper + Dashboard

Scrape IT job listings từ [topdev.vn/viec-lam-it](https://topdev.vn/viec-lam-it) bằng Playwright + Cheerio. Dashboard HTML để khám phá data.

Repo này fork cấu trúc từ [itviec-scraper](https://github.com/haucongle/itviec-scraper); selectors + flow đã được adjust cho TopDev (Next.js CSR, render-after-mount).

## ⚠️ Status: WIP selectors

TopDev dùng Next.js client-side render — HTML ban đầu không có job data. Lần chạy đầu tiên scraper sẽ:
1. Mở Playwright (stealth) → navigate → chờ `CONFIG.renderWaitMs` ms để JS render
2. Scroll to bottom để trigger lazy-load (nếu infinite scroll)
3. Dump `debug-page1.html` (rendered DOM)
4. Parse với selectors **placeholder** trong [scraper.js](scraper.js) — có thể trả về 0 jobs

**Bạn cần:**
1. Chạy `node scraper.js` lần 1 với `headless: false` để xem browser (đặt trong `CONFIG`)
2. Inspect `debug-page1.html` (dump bởi scraper) hoặc trực tiếp qua DevTools
3. Update 2 hàm `parseJobList` + `parseJobDetail` trong [scraper.js](scraper.js) — grep `// TODO:` để tìm những chỗ cần sửa

## Install

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node scraper.js              # scrape (có resume qua topdev-state.json)
npx serve .                  # mở dashboard: http://localhost:3000/dashboard.html
```

### Login cookies (để lấy data behind login nếu cần)

Giống ITviec workflow:
1. Login topdev.vn trên Chrome
2. DevTools → Network → Copy header `Cookie`
3. Paste vào `cookies-raw.txt`
4. `node build-cookies.js` → tạo `topdev-cookies.json`

## Config

Trong [scraper.js](scraper.js) `CONFIG`:

| Key | Default | Ý nghĩa |
|---|---|---|
| `baseUrl` | `https://topdev.vn/viec-lam-it` | List endpoint |
| `maxPages` | `null` | `null` = tất cả |
| `headless` | `true` | `false` khi dev |
| `detailConcurrency` | `2` | Concurrency detail (giảm so với ITviec vì render chậm) |
| `renderWaitMs` | `2500` | Chờ Next.js render trước khi parse |
| `scrollToBottom` | `true` | Scroll để trigger lazy load |

## Files

| File | Purpose | Gitignored? |
|---|---|---|
| [scraper.js](scraper.js) | Main scraper | no |
| [build-cookies.js](build-cookies.js) | Cookie header → storageState | no |
| [dashboard.html](dashboard.html) | Single-file dashboard | no |
| [.github/workflows/crawl.yml](.github/workflows/crawl.yml) | Daily 7:15 ICT run | no |
| `topdev-jobs.json` | Output (commit để host Pages) | no (on purpose) |
| `topdev-state.json` | Resume checkpoint | yes |
| `topdev-cookies.json` | Session | yes |
| `cookies-raw.txt` | Raw cookie input | yes |
| `debug-page1.html` | Rendered HTML để inspect selectors | yes |

## GitHub Pages

Sau khi push lên GitHub, enable Pages (Settings → Pages → Deploy from branch `main` / root). URL:

```
https://<user>.github.io/topdev-scraper/dashboard.html
```

Action cron sẽ tự commit `topdev-jobs.json` mỗi ngày → Pages tự rebuild.

## Tech stack

Giống itviec-scraper: playwright-extra + stealth + cheerio + p-limit.

## License

ISC. Tuân thủ [TopDev ToS](https://topdev.vn) và `robots.txt`.
