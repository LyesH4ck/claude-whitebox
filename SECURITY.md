# Security Policy

## Intended Use

claude-pentest is a Claude Code plugin for **authorized penetration testing only**.

Users are responsible for ensuring they have explicit written authorization before testing any system. Unauthorized use against systems you do not own or have permission to test is illegal in most jurisdictions.

## Responsible Use Requirements

- Always obtain written authorization (scope agreement, bug bounty rules, etc.) before running any test
- Stay within the defined scope — do not test systems outside what was authorized
- Do not use this tool to attack critical infrastructure, healthcare systems, or emergency services
- Do not use findings to cause harm, extort, or disclose without coordinated disclosure

## Scope of This Security Policy

This policy covers security vulnerabilities **in the plugin itself**, such as:

- Code execution or privilege escalation via malicious skill/agent files
- Credential leakage through log files or output artifacts
- Path traversal in output folder creation
- Injection vulnerabilities in tool scripts

It does **not** cover the behavior of the attack techniques documented in the skills library — those are intentionally offensive by design.

## Reporting a Vulnerability

If you find a security issue in the plugin code or workflow logic:

1. **Do not open a public GitHub issue**
2. Open a GitHub [Security Advisory](../../security/advisories/new) (private disclosure)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (optional)

You will receive an acknowledgment within 72 hours. Critical issues will be patched on a best-effort basis.

## Out of Scope

The following are not considered vulnerabilities:

- Payloads in the `attacks/` skill library that are documented offensive techniques
- Findings from running the tool against systems you own or have authorized access to
- Features that require user-provided credentials (this is by design)

## Supported Versions

This project follows a rolling release model. Only the latest commit on `main` is actively maintained.

| Branch | Supported |
|--------|-----------|
| main   | Yes       |
| older  | No        |

## Legal

Use of this tool implies agreement that you are acting within the law and with proper authorization. The maintainers are not liable for misuse.
