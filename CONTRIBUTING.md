# Contributing to claude-pentest

Thank you for your interest in contributing. This project is a Claude Code plugin for authorized penetration testing workflows.

## Scope

Contributions are welcome in these areas:

- New attack skill modules (`skills/pentest/attacks/`)
- New payload files for existing attack categories
- Improvements to reconnaissance, reporting, or orchestration workflows
- Bug fixes in skill logic, agent definitions, or tool scripts
- Documentation improvements

## Ground Rules

**All contributions must be for defensive / authorized testing purposes only.**

- No payloads or techniques designed to evade detection on systems without authorization
- No content targeting critical infrastructure, hospitals, or emergency services
- No malware, ransomware, or destructive payloads
- No doxxing, stalkerware, or privacy-violating tools

## Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-skill`
3. Make your changes following the conventions below
4. Commit with conventional commits: `feat:`, `fix:`, `docs:`, `chore:`
5. Open a pull request with a clear description

## Skill File Conventions

### New attack skill

Place under `claude-pentest/plugins/pentest/skills/pentest/attacks/<category>/<technique>/`:

```
<technique>/
  <technique>-quickstart.md   # Step-by-step attack guide
  <technique>-cheat-sheet.md  # Quick reference
  payloads/
    basic.md                  # Core payloads
    bypass.md                 # Filter/WAF bypass variants (if applicable)
```

### Quickstart format

```markdown
# <Technique Name>

## Prerequisites
- Tools required
- Required access level

## Detection
How to identify this attack surface.

## Exploitation
Step-by-step commands with comments.

## Remediation
How to fix this vulnerability.
```

### Payload files

- One payload per line or in clearly labeled code blocks
- Include brief comments explaining what each payload targets
- Group by variant or context (e.g., MySQL vs PostgreSQL, Linux vs Windows)

## Agent Definitions

Agent files live in `claude-pentest/plugins/pentest/agents/`. They are markdown files with a YAML frontmatter block. Keep agent descriptions focused on a single attack domain.

## Code (Python tools)

- Python tools go under `skills/<skill>/tools/`
- Follow PEP 8
- Add type hints
- No hardcoded credentials or IPs
- Keep functions under 50 lines

## Pull Request Checklist

- [ ] Tested against a lab environment (HackTheBox, TryHackMe, DVWA, etc.)
- [ ] No real credentials, tokens, or IP addresses included
- [ ] Follows the file and format conventions above
- [ ] PR description explains what the contribution adds and why

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Claude Code version and OS

For security vulnerabilities in this plugin itself, see [SECURITY.md](SECURITY.md).
