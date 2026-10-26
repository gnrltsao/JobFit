# JobFit

Upload a resume (PDF, Word, or text) or type your experience as bullets. JobFit scores job postings from the last 24–72 hours on a 1–5 fit scale and shows only the 4s and 5s.

- **Hosting:** a static site on GitHub Pages. There is no server and no database.
- **Job data:** a GitHub Action runs every morning, reads public job boards, and commits the results to `data/jobs.json`.
- **Scoring:** happens in the visitor's browser with their own Claude API key. Neither the key nor the resume ever touches this repo.

## How it works

```
GitHub Action (daily) ──► Greenhouse / Lever / Ashby / Workday* feeds
        │
        ▼
data/jobs.json  (postings from the last 72h, ~1,500 chars of description each)
        │
        ▼
index.html in the visitor's browser
  1. read resume (pdf.js / mammoth)        all local
  2. filter: time window, remote/hybrid/on-site, locations
  3. rank by keyword overlap, keep top N (20–100)
  4. Claude scores each of the N from 1 to 5 with a one-line reason
  5. show score ≥ 4, drop the rest
```

\* Workday is **experimental**. It uses the undocumented JSON endpoint behind each company's Workday career site, which can change or block automated traffic without notice.

### Scoring rubric (sent to Claude)

| Score | Meaning |
|---|---|
| 5 | Strong match. Meets nearly all core requirements; function, seniority and domain align. |
| 4 | Good match. Meets most requirements, with one manageable gap. |
| 3 | Partial match. Same function family, but notable gaps. |
| 2 | Weak match. Some transferable skills. |
| 1 | No match. |

A role that clearly conflicts with a stated preference (location, work arrangement, or posted pay) is capped at 2.

## Setup (about 10 minutes)

1. **Create the repo.** Make a new **public** GitHub repository and upload everything in this folder, including the hidden `.github` folder. (GitHub Pages on a free account requires a public repo.)
2. **Let the Action write.** Go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**.
3. **Turn on Pages.** Go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, then pick *main* and */ (root)*.
4. **Fill the data.** Go to **Actions → Fetch jobs → Run workflow**. A run takes a few minutes. After that, it repeats every morning at about 6:17 AM Eastern.
5. **Check the sources.** Open the site at `https://<your-username>.github.io/<repo-name>/` and click the data pill in the top-right corner. It lists every job board and whether it was reached.
6. **Fix the employer list.** Fix or delete the boards that failed in `data/companies.json`.

## Adding employers

Edit `data/companies.json`:

```json
{"name": "Acme",  "ats": "greenhouse", "slug": "acme"}
{"name": "Acme",  "ats": "lever",      "slug": "acme"}
{"name": "Acme",  "ats": "ashby",      "slug": "acme"}
{"name": "Acme",  "ats": "workday",    "host": "acme.wd5.myworkdayjobs.com", "tenant": "acme", "site": "AcmeCareers"}
```

To find a company's board, open its careers page and click any job. The link it lands on tells you the system and the slug:

| Link looks like | Entry to add |
|---|---|
| `boards.greenhouse.io/acme` or `job-boards.greenhouse.io/acme` | Greenhouse, slug `acme` |
| `jobs.lever.co/acme` | Lever, slug `acme` |
| `jobs.ashbyhq.com/acme` | Ashby, slug `acme` |
| `acme.wd5.myworkdayjobs.com/AcmeCareers` | Workday, host `acme.wd5.myworkdayjobs.com`, tenant `acme`, site `AcmeCareers` |

**The starter list is unverified.** The slugs are best guesses, so expect some to fail on the first run. That's what the sources report is for.

## What it does not cover, and why

- **LinkedIn, Indeed, Glassdoor, BuiltIn, Welcome to the Jungle (Otta).** They have no public job feed, and their terms prohibit scraping.
- **Every posting on Greenhouse, Lever or Ashby.** Those feeds are per company, with no global "everything posted today" endpoint, so coverage is exactly the employer list.

## Known limitations

- **Greenhouse dates.** Greenhouse supplies a true first-published date on most boards. When it's missing, JobFit falls back to the last-updated date, and the card is labelled "date = last updated".
- **Workday dates** are approximate ("Posted 2 Days Ago"), and each Workday tenant is capped at 150 recent postings per run.
- **Only the top N keyword matches are sent to Claude.** A strong role with unusual wording can be missed. Raising "Roles to score" reduces that risk but costs more.
- **Cost:** each search sends the resume plus about 8 postings per request. The resume part is prompt-cached. Expect a few cents (Haiku) to tens of cents (Opus) per search at Top 40.

## Running the fetcher locally

```bash
python3 scripts/fetch_jobs.py --hours 72                 # all sources
python3 scripts/fetch_jobs.py --only greenhouse,lever    # subset
python3 -m http.server 8000                              # then open http://localhost:8000
```

Standard-library Python 3.11+ only. No installs needed.

## Privacy

The resume is parsed in the browser. When the visitor clicks **Find my matches**, the resume text, their preferences and the shortlisted postings go directly from their browser to `api.anthropic.com` under their own key. Nothing is sent to this repo or any other server. If "Remember key on this device" is ticked, the key is saved in that browser's local storage. Otherwise it's gone when the tab closes.
