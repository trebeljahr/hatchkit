# Security Policy

## Supported Versions

Security fixes target the current `main` branch and the latest published npm release of `hatchkit`.

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities, leaked credentials, or exploitable deployment behavior.

Report privately by using GitHub's private vulnerability reporting if it is enabled for the repository, or contact the maintainer directly from the GitHub profile.

Include:

- Affected package, command, or generated file.
- Reproduction steps.
- Expected impact.
- Whether any real provider, DNS, Coolify, Terraform, keychain, or secret state was touched.

## Secrets

Hatchkit is designed so provider tokens live in the OS keychain and project secrets stay encrypted. Never include live tokens, dotenvx private keys, webhook URLs, or provider API responses containing secrets in issues, PRs, logs, screenshots, or test fixtures.
