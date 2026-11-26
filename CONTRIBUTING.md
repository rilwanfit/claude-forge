# Contributing to Claude Forge

Thank you for helping. This guide is short on purpose.

## The rules

1. `main` is protected. You cannot push to it. Every change arrives through a pull request (PR).
2. Fork the repository. Create a branch in your fork. Open the PR from that branch.
3. The tests must pass. At least one maintainer must approve the PR.
4. Keep each PR to one change. Small PRs get reviewed faster.

## Set up

You need Node.js 22 or later. The project has no dependencies, so there is nothing to install.

```sh
git clone https://github.com/<your-user>/claude-forge.git
cd claude-forge
node server.mjs
```

Then open http://127.0.0.1:4777.

## Run the tests

```sh
node --test test/*.test.mjs
```

The tests use a fake Claude and need no network. Some tests read `/proc`, so they pass on Linux only. The CI runs on Linux. On macOS, expect failures in `test/reply.test.mjs`.

Add or update a test for each change in behavior.

## Make a change

1. Create a branch with a short name, for example `fix-reply-timeout`.
2. Make your change. Follow the style of the code around it.
3. Run the tests.
4. Update `README.md` if the change affects how people use the project.
5. Commit. Push to your fork. Open a PR against `main`.

## Commit messages

- Write the first line in the imperative mood, for example `Fix the layout jump between projects`.
- Keep the first line under 72 characters.
- Use the body to explain why you made the change, not only what changed.

## What must never be in a commit

`config.json`, `state.json` and `data/` hold personal paths and session text. Git ignores them. Do not force-add them.

Do not commit tokens, passwords, personal email addresses or absolute paths from your own machine. Check `git diff --staged` before you commit.

## Reviews

A maintainer reviews every PR. Expect questions and requests for changes. Answer in the PR and push new commits. A maintainer merges with a squash merge.

## Report a bug or ask for a feature

Check the [FAQ](FAQ.md) first. Open an issue and fill in the template. To report a security problem, do not open an issue. Follow `SECURITY.md`.

## Code of conduct

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
