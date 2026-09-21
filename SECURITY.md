# Security Policy

## reporting

open a GitHub issue or email the repo owner. do not include token files or
request payloads containing personal data in reports.

## scope

- this relay runs locally and reads your own oauth token files. nothing is
  transmitted anywhere except `oauth2.googleapis.com` (token refresh) and the
  configured cloud-code backend.
- the public oauth client id/secret embedded in `src/credentials/oauth.js`
  are Google's own publicly distributed identifiers, present in every
  antigravity/gemini cli install. they are not credentials of this project.

## hardening checklist

- keep the relay on 127.0.0.1; if you must expose it, set `apiKey` and put
  tls in front (the relay speaks plain http).
- never commit `config.json`, token files, or anything under `accounts/`.
- a leaked refresh token = revoke it (google account → security → third-party
  access) and re-login.
