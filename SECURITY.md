# Security policy

## Supported scope

Security changes target the current `main` branch. Historical commits and arbitrary self-hosted configurations are not maintained releases.

This is an integration prototype. Operator access is not tenant authentication. Real provider/database flows require deployment-specific validation.

## Report a vulnerability

Use **Security → Report a vulnerability** if private reporting is available. Otherwise, contact the maintainer through the contact address on [Pratham Gupta's GitHub profile](https://github.com/Prathamg042004). Do not publish credentials, personal data, exploit payloads against real users, or confidential documents in a public issue.

Include the affected commit, expected versus actual behavior, impact, and minimal reproduction with synthetic data. Test only accounts and systems you own or are authorized to assess. Response and remediation are best effort; no guaranteed response time or bounty is offered.

## Credentials and deployment

Keep secrets in server-side environment configuration, never in repository files or browser bundles. Revoke exposed credentials at their providers; removing a secret from the current source does not invalidate copies in Git history. Verify auth, data ownership and dependency changes against the actual deployment before public use.
