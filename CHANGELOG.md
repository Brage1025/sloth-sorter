# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added
- `sample-files` folder with made-up messy files for trying the app.
- Dark and light appearance in Settings (dark by default, or match the computer).
- Settings: "Forget what I've learned" button (with an "are you sure" box) that clears remembered results so the next scan looks at every file again.
- Tests run automatically on Windows, macOS and Linux for every push and pull request.
- CONTRIBUTING guide and this changelog.
- README section on current limits.

### Fixed
- Files created a moment ago could be skipped by a scan on Windows and macOS (clock rounding). Found by the new cross-platform tests.
- A PDF that one PDF engine cannot open is now retried with the two other engines before falling back to sorting by file type.

## 1.0.0 (not yet released)

First version.

### Added
- Local AI file tidying with Ollama (default model gemma3:4b): reads text, PDFs, Word files and photos, suggests readable names and folders.
- Review screen with editable names and folders before anything moves.
- Undo history, collision-safe moves, top-level files only, extension never changed.
- Sleep mode: background tidying of a folder from the tray or menu bar.
- Guided first-run setup for Ollama and the model.
- Page sampling and whole-document clues for long PDFs, and reading scanned PDFs with a vision model.
- Result cache, time estimate and a hint when the AI is running on the CPU only.
- Fallback to sorting by file type when the AI is off or unavailable.
- Installers for Windows, macOS and Linux built by GitHub Actions (unsigned).

### Changed
- Dates in file names come only from text in the document, never from the modified date, today's date or pictures.
- Logo is now an "SS" monogram.
