# Changelog

All notable user-facing changes should be documented here.

This project follows npm package versions for the `hatchkit` CLI. Dates use `YYYY-MM-DD`.

## Unreleased

### Added

- Added GitHub community health files, issue templates, release-note config, Dependabot config, and package metadata so the repository is easier to evaluate and contribute to.
- Added Listmonk newsletter subscribe/confirm handlers plus newsletter send and draft scripts.
- Added an opinionated email intent prompt for choosing Resend transactional email or Listmonk+SES newsletters.
- Added an opinionated S3 prompt that defaults new projects to Cloudflare R2 while preserving existing-storage setup.
- Added Listmonk+SES provisioning for transactional/campaign templates and `LISTMONK_TEST_LIST_ID`/`LISTMONK_FROM` env surfaces.

## 0.1.47

- Current published CLI version.
