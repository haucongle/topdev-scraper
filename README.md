# TopDev Scraper + Dashboard

Scrape IT job listings từ [topdev.vn](https://topdev.vn/jobs/search) qua backend API của TopDev. Dashboard HTML để khám phá data.

Repo fork cấu trúc từ [itviec-scraper](https://github.com/haucongle/itviec-scraper).

## How it works

TopDev là Next.js CSR — HTML ban đầu không có job data. Thay vì DOM-scrape (chậm + bất định), scraper gọi thẳng API mà frontend đang dùng:

```
GET https://api.topdev.vn/td/v2/jobs/search/v2?page=N&fields[job]=...&fields[company]=...
```

Response đã có sẵn full detail (title, salary, company, content, requirements, benefits…) nên **một request / trang là đủ**, không cần fetch detail page riêng. Playwright chỉ dùng để warm-up Cloudflare clearance cookie trước khi gọi API.

Tổng ~5000 jobs / ~335 trang / 15 jobs per page → ~10 phút cho full scrape.

## Install

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node scraper.js              # scrape (resume qua topdev-state.json)
npx serve .                  # dashboard: http://localhost:3000/dashboard.html
```

## Config

Trong [scraper.js](scraper.js) `CONFIG`:

| Key | Default | Ý nghĩa |
|---|---|---|
| `apiBase` | `https://api.topdev.vn/td/v2/jobs/search/v2` | API endpoint |
| `maxPages` | `null` | `null` = tất cả |
| `headless` | `true` | `false` khi debug CF challenge |
| `saveEvery` | `5` | Save state mỗi N pages |
| `pageDelayMs` | `[800, 2000]` | Jitter giữa các API call |

## Files

| File | Purpose | Gitignored? |
|---|---|---|
| [scraper.js](scraper.js) | Main scraper | no |
| [dashboard.html](dashboard.html) | Single-file dashboard | no |
| [.github/workflows/crawl.yml](.github/workflows/crawl.yml) | Daily 7:15 ICT run | no |
| `topdev-jobs.json` | Output (commit để host Pages) | no (on purpose) |
| `topdev-state.json` | Resume checkpoint | yes |
| `topdev-cookies.json` | CF clearance storage state | yes |

## GitHub Pages

Sau khi push lên GitHub, enable Pages (Settings → Pages → Deploy from branch `main` / root). URL:

```
https://<user>.github.io/topdev-scraper/dashboard.html
```

Action cron tự commit `topdev-jobs.json` mỗi ngày → Pages tự rebuild.

## Tech stack

playwright-extra + stealth (CF warm-up) + TopDev public API.

## License

ISC. Tuân thủ [TopDev ToS](https://topdev.vn) và `robots.txt`.
