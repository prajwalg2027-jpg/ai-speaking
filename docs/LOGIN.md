# Phone login (MSG91 OTP)

Learners (Android app) and admins (`/admin/`) sign in with an SMS code. The **server** talks to MSG91's OTP
Widget API; the app and the admin page only talk to the server.

```
app / admin page                 Adam server (server/login.js)                MSG91 (control.msg91.com)
  │ POST /api/auth/otp/send {phone} │                                              │
  │────────────────────────────────▶│ checks: Indian mobile, limits                │
  │                                 │──── POST /api/v5/widget/sendOtp ────────────▶│ SMS to the phone
  │◀── {requestId} ─────────────────│◀─── {type:success, message:<reqId>} ─────────│
  │ POST /api/auth/otp/verify       │                                              │
  │   {requestId, code}             │ 5 tries max, one use                         │
  │────────────────────────────────▶│──── POST verifyOtp {reqId, otp} ────────────▶│
  │                                 │◀─── {type:success, message:<JWT>} ───────────│
  │                                 │──── POST verifyAccessToken (authkey) ───────▶│
  │                                 │◀─── the verified number ─────────────────────│
  │                                 │ the number must be the one the code went to  │
  │◀── {token, expiresAt, user} ────│ customer found or created by phone; session  │
  │ every request: Authorization: Bearer <token>                                    │
```

## Why the server, not the app, calls MSG91

- MSG91's **authkey** never leaves the server (Secret Manager). The app holds nothing MSG91-specific, so the
  widget or provider can change without an app update.
- Each SMS costs money and OTP endpoints attract abuse, so the server limits sending: Indian mobile numbers
  only (no international SMS pumping), 5 codes per number and 20 per address an hour, a daily cap (3,000).
- The code is checked against the request it was sent for, and MSG91's verified number must match it.

## Endpoints

| | Body | Answer |
|---|---|---|
| `POST /api/auth/otp/send` | `{phone}` (any common Indian form) | `{requestId, codeLength: 6, resendAfterSec: 30, expiresInSec: 600}` |
| `POST /api/auth/otp/resend` | `{requestId, channel?}` (`sms`, `voice`, `whatsapp`) | `{ok, resendAfterSec}`; 30 s apart, 3 at most |
| `POST /api/auth/otp/verify` | `{requestId, code, client?}` | `{token, expiresAt, user: {id, phone, created}}` |
| `POST /api/auth/refresh` | signed in | `{token, expiresAt}` |
| `POST /api/auth/logout` | signed in | `{ok}` |

Refusals: `{error, reason}`, where `error` is `invalid_number` (400), `too_many_requests` (429), `wrong_code`
(400), `code_expired` (410: expired, already used, or unknown) or `unavailable` (503); `reason` is a sentence for
the screen.

## Sessions (`server/sessions.js`)

The token is a JWT (HS256, signed with `SESSION_SECRET`) naming a row in `sessions`. It lasts 60 days; the app
refreshes it when less than a week is left. A session is trusted for a minute after it's checked, so signing
out, or deleting the account (which deletes its sessions), takes effect within a minute everywhere, and at once
on the device and server that did it. One phone number is one customer: someone who signed in with Firebase
before keeps their account (matched by number).

## Settings

| Name | Where | Meaning |
|---|---|---|
| `MSG91_AUTHKEY` | Secret Manager `msg91-authkey` | MSG91 account authkey |
| `MSG91_WIDGET_ID` | env | The OTP widget (6-digit OTP, captcha and invisible OTP off) |
| `SESSION_SECRET` | Secret Manager `adam-session-secret` | Signs session tokens (made randomly by `deploy/msg91-setup.sh`) |
| `ADMIN_PHONES` | env | Numbers allowed into `/admin/` |
| `MSG91_TEST_PHONE`, `MSG91_TEST_CODE` | env | Optional: a number that signs in with a fixed code, no SMS (never an admin) |
| `OTP_PER_PHONE_PER_HOUR`, `OTP_PER_IP_PER_HOUR`, `OTP_PER_DAY` | env | Limits (5, 20, 3,000) |
| `MSG91_BASE_URL` | env | Tests only |

## Tests

`test/login.test.js` (fake MSG91, real PostgreSQL): number checks, what MSG91 receives, wrong codes and the
5-try lock, one use, a different verified number refused, limits, resend timing and channel, refresh and
sign-out, tampered tokens, a Firebase-era customer kept, erasure, the test number, admin access.
`android/.../OtpPhoneAuthTest.kt`: the app's side against a fake server.

## Not yet checked against the real MSG91

The request and error shapes come from MSG91's OpenAPI docs and its own SDKs, and the error shape was confirmed
with a live call. The **successful** `verifyAccessToken` answer isn't documented field by field: the server finds
the verified number anywhere in it and refuses a different one; if it carries no number, the server relies on
its own record of which number the code was sent to (and logs the answer's field names, so the first real
sign-in shows the shape). Try it with your own number before release.
