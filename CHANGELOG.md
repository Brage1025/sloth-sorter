# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

Nothing yet.

## 1.0.0 - 2026-10-23

First release.

### Added
- Local AI file tidying with Ollama (default model gemma3:4b): reads text, PDFs, Word files and photos, suggests readable names and folders.
- Review screen with editable names and folders before anything moves.
- Undo history, collision-safe moves, top-level files only, extension never changed.
- Sleep mode: background tidying of a folder from the tray or menu bar, with an option to keep sleeping in the tray when the window is closed.
- Guided first-run setup for Ollama and the model.
- Page sampling and whole-document clues for long PDFs, and reading scanned PDFs with a vision model.
- Result cache, time estimate and a hint when the AI is running on the CPU only.
- "Forget what I've learned" button in Settings, with an "are you sure" box.
- Dark and light appearance in Settings (dark by default, or match the computer).
- Fallback to sorting by file type when the AI is off or unavailable.
- `sample-files` folder with made-up messy files for trying the app.
- Tests that run on Windows, macOS and Linux for every push and pull request.
- Installers for Windows, macOS and Linux built by GitHub Actions (unsigned).

### Notes
- Dates in file names come only from text in the document, never from the modified date, today's date or pictures.
- A scan skips nothing because of clock rounding, and a PDF that one engine cannot open is retried with the other engines before falling back to sorting by file type.
