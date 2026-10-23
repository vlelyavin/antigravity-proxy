# Security Policy

## Reporting

To report a security issue, open a GitHub issue or email the repository owner. Do not include token files or request payloads containing sensitive or personal data in your reports.

## Scope

- This relay runs locally and only reads your local OAuth token files. No data is transmitted anywhere other than `oauth2.googleapis.com` (for token refreshes) and the configured Cloud Code backend.
- The public OAuth client ID and secret embedded in `src/credentials/oauth.js` are Google's publicly distributed identifiers, present in every Antigravity/Gemini CLI installation. They are not private credentials of this project.

## Hardening Checklist

- Keep the relay bound to `127.0.0.1`. If you must expose it, set an `apiKey` and terminate TLS in front of it (the relay serves plain HTTP).
- Never commit `config.json`, token files, or any files under `accounts/`.
- If a refresh token is leaked, revoke it immediately (Google Account → Security → Third-party access) and log in again.
