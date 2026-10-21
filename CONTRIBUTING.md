# Contributing to Sloth Sorter

Thanks for helping. This project is small on purpose, so it is easy to get into.

## Set up

```bash
git clone https://github.com/Brage1025/sloth-sorter
cd sloth-sorter
npm install
npm start
```

You do not need Ollama or a model to work on most things. Start the mock instead:

```bash
node test/mock-ollama.js 11500 &
SLOTH_OLLAMA_HOST=http://127.0.0.1:11500 SLOTH_FOLDER=/some/messy/dir npm start
```

Do not run `npm audit fix --force`. It can downgrade packages that the app depends on.

## Run the tests

```bash
npm test
```

The tests need no network and no real model. They run on Windows, macOS and Linux for every push and pull request (see `.github/workflows/ci.yml`), so please keep them passing on all three. Watch for path separators and case-sensitive file names.

Useful environment variables:

- `SLOTH_DEBUG=1` prints what the model was shown for each file, and how long it took.
- `SLOTH_USER_DATA`, `SLOTH_FOLDER` and `SLOTH_OLLAMA_HOST` point the app at a scratch settings folder, a test folder and a different Ollama.

## Where things live

Logic goes in `src/core/` (plain Node, no Electron) so it can be tested. `src/main.js` and `src/renderer/` are thin. The README has a map of the files.

## Rules that must not break

These are what make the app safe to run on someone's real files. A change that weakens one will not be merged.

- Never delete a file and never overwrite one. A name clash gets a `(2)`.
- Only touch the top level of the chosen folder. Skip hidden, half-downloaded and shortcut files.
- Never change a file extension.
- Every move is written to the undo history.
- Nothing leaves the computer. No network calls except to the local Ollama.
- A date goes in a file name only if it is printed in the document's text.

## Changing how files are named or sorted

Quality problems usually come from the prompt in `src/core/classify.js` or the text gathered in `src/core/extract.js`. When you fix one:

1. Add a test that reproduces it, using the mock (`test/mock-ollama.js`) or a small fixture in `test/fixtures/`.
2. Check it against a real model too if you can, since the mock cannot judge quality. Say which model you used in the pull request.
3. Remember that results are cached. Use Settings, Forget what I've learned, before re-scanning.

## Pull requests

- Keep each pull request focused on one thing.
- Describe what changed and how you tested it.
- Add a line to `CHANGELOG.md` under "Unreleased".
- No emojis in the README or docs, please.

## Reporting a bug

Open an issue with your operating system, the model you use, what you expected and what happened. If a name or folder was wrong, run with `SLOTH_DEBUG=1` and include the line for that file. Remove anything private first.
