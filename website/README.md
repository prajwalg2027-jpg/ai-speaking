# adamspeaks.in

The public site for the Adam app, built in the app's design (Terracotta & Peacock, Anek font, molten orb).

| Page | Used by |
|---|---|
| `/` | Landing page: "coming soon" on Google Play and the App Store |
| `/privacy` | Privacy policy: Play Console, app's consent screen |
| `/terms` | Terms of use: app's consent screen |
| `/delete-account` | Play Console's "Delete account URL" (Data safety) |

Static files, with no cookies, analytics or third-party requests. Hosted on **Firebase Hosting** in the same
Google Cloud project as the app's server and phone login.

## 1. Fill in `site.config.json`
Contact email (`SUPPORT_EMAIL`) and the policy date. Every value must be filled in.
Preview locally: `node build.mjs --preview && npx serve dist`.

## 2. Deploy (Google Cloud Shell)
```bash
git clone -b claude/dazzling-cray-ni75q7 https://github.com/prajwalg2027-jpg/ai-speaking.git && cd ai-speaking/website
```
```bash
firebase deploy --only hosting --project YOUR_PROJECT_ID
```

## 3. DNS
Firebase console → Hosting → **Add custom domain** → `adamspeaks.in`, then `www.adamspeaks.in` (redirect to
`adamspeaks.in`). Add the records it shows (a `TXT` record and an `A` record on `@`, plus a record for `www`)
at whoever hosts the domain's DNS. SSL is automatic.

- Leave **`api.adamspeaks.in` alone**. It's reserved for the app's server, and this site uses only `@` and `www`.
- Email for `prajwal@adamspeaks.in`: add your mail provider's `MX` and SPF `TXT` records on `@`
  (for example, ImprovMX forwarding to Gmail: `MX mx1.improvmx.com 10`, `MX mx2.improvmx.com 20`,
  `TXT v=spf1 include:spf.improvmx.com ~all`).

To see where the DNS is managed, run this in Cloud Shell:
```bash
dig +short NS adamspeaks.in
```

## app-config.json (read by the Adam app)

`src/app-config.json` is served at `https://adamspeaks.in/app-config.json`. The Android app reads it at start-up:

- `serverUrl`: the Adam server the app talks to. Change it here to move the server without an app update
  (the app only accepts `https://` addresses on `adamspeaks.in` or Google Cloud Run).
- `minVersionCode`: apps older than this ask the learner to update from Google Play.

Deploy the website after editing it. Apps pick the change up within about 5 minutes of their next start.
