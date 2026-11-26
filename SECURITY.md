# Security policy

Claude Forge can read your Claude session text and start Claude runs on your machine. Please report security problems privately.

## How to report

Use GitHub private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Select **Report a vulnerability**.
3. Describe the problem and the steps to reproduce it.

Do not open a public issue for a security problem.

## What to expect

- The maintainer reads each report and replies as soon as possible.
- The maintainer fixes confirmed problems and credits the reporter, unless the reporter asks for no credit.

## Supported versions

Only the latest commit on `main` receives fixes.

## Safe use

- By default the server accepts connections from this machine only.
- If you set `DASH_HOST` to another address, you must also set a token of 16 characters or more. There is no TLS. Use only a trusted network, a VPN or an HTTPS reverse proxy.
