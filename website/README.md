# adamspeaks.in: landing page + privacy policy

A static site with no build dependencies, cookies, analytics or third-party requests. It's
hosted on **Firebase Hosting** inside your Google Cloud project: free SSL, a global CDN,
and no monthly cost at landing-page traffic. A GCS bucket behind a load balancer would
cost about $18/month for the same result.

```
website/
  site.config.json   ← the only file you edit: email, operator name/address, grievance officer
  src/               index.html, privacy.html, 404.html, styles.css, site.js, images
  build.mjs          fills {{TOKENS}} from site.config.json → dist/ (refuses if any are blank)
  firebase.json      hosting config: clean URLs (/privacy), security headers, 404
```

Preview locally: `node build.mjs --preview && npx serve dist` (blank fields show as `[PLACEHOLDERS]`).

## 1. Fill in `site.config.json`

| Key | What to put | Example |
|---|---|---|
| `OPERATOR_NAME` | Legal name of the person or company running AdamSpeaks | `Prajwal G` or `XYZ Learning Pvt Ltd` |
| `OPERATOR_ADDRESS` | City, state (a full postal address is better for DPDP grievances) | `Bengaluru, Karnataka, India` |
| `GRIEVANCE_OFFICER` | Name of the person who handles privacy complaints (can be you) | `Prajwal G` |
| `CONTACT_EMAIL` | Already `hello@adamspeaks.in`. Set up forwarding (step 4) | |
| `POLICY_DATE` | Effective date of the policy | `19 November 2026` |

## 2. Deploy (Google Cloud Shell, about 5 minutes)

Open <https://shell.cloud.google.com>. Node and the Firebase CLI are already installed there.

```bash
git clone https://github.com/prajwalg2027-jpg/ai-speaking.git && cd ai-speaking/website
```

```bash
export PROJECT_ID=your-gcp-project-id
```

Add Firebase to your existing GCP project (one time only; skip if it already shows up in the Firebase console):

```bash
firebase projects:addfirebase $PROJECT_ID
```

Edit `site.config.json` (`cloudshell edit site.config.json`), then deploy:

```bash
firebase deploy --only hosting --project $PROJECT_ID
```

You'll get a live URL like `https://<project-id>.web.app`. Check it before connecting the domain.

## 3. Connect adamspeaks.in (DNS)

1. Firebase console → your project → **Hosting** → **Add custom domain** → `adamspeaks.in`.
2. Add **`www.adamspeaks.in`** too, and choose **Redirect to adamspeaks.in**.
3. Firebase shows the exact records. Add them at your domain registrar. They look like this:

| Type | Host / Name | Value | Purpose |
|---|---|---|---|
| `TXT` | `@` | `hosting-site=<project-id>` (copy from console) | Proves you own the domain |
| `A` | `@` | `199.36.158.100` (**use the IP the console shows**) | Points the domain at Firebase |
| `A` or `CNAME` | `www` | as shown in the console for www | www → redirect to apex |

- **Delete** any existing `A`/`AAAA`/`CNAME` records on `@` and `www` (registrar parking pages).
- If your registrar has **CAA** records, add `0 issue "pki.goog"` and `0 issue "letsencrypt.org"`, or the certificate can't be issued.
- SSL is issued automatically. It usually takes 15 minutes to a few hours, sometimes up to 24.

## 4. Contact email: hello@adamspeaks.in

The domain needs a mailbox or forwarder. Pick **one** of these:

**A. Free forwarding to your Gmail ([ImprovMX](https://improvmx.com))**: simplest
| Type | Host | Value | Priority |
|---|---|---|---|
| `MX` | `@` | `mx1.improvmx.com` | 10 |
| `MX` | `@` | `mx2.improvmx.com` | 20 |
| `TXT` | `@` | `v=spf1 include:spf.improvmx.com ~all` | |

Then, in Gmail, go to **Settings → Accounts → Send mail as** and add `hello@adamspeaks.in`
using ImprovMX's SMTP (a paid plan) to reply *from* that address. Otherwise you can only
receive mail there and reply from Gmail.
Many Indian registrars (GoDaddy, Hostinger, BigRock) also offer free email forwarding in their DNS panel.

**B. Google Workspace** (about ₹136/user/month): a real mailbox. Workspace gives you its own MX (`smtp.google.com`) and SPF (`include:_spf.google.com`) records.

There can be **only one** `v=spf1` TXT record on `@`. Firebase's `hosting-site=` TXT record is separate and can sit alongside it.

## Updating the site later
Edit files in `src/`, then run `firebase deploy --only hosting --project $PROJECT_ID`.
The build runs automatically as a predeploy step.
