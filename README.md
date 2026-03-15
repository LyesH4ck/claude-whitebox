# claude-pentest

An open-source Claude plugin repository for **authorized penetration testing workflows**.

This repository currently includes a `pentest` plugin built around orchestrators, executor agents, reusable skills, and reporting workflows for structured security assessments.

## Overview

The repository is structured as a Claude plugin/marketplace project and currently contains a `pentest` plugin designed for security assessment workflows.

The `pentest` plugin is described as a full penetration testing framework covering areas such as:

- OWASP-style web testing
- injection testing
- authentication testing
- cloud security testing
- API assessment
- domain and application mapping
- reporting and findings generation

The workflow is centered on:

- a **Pentester Orchestrator**
- specialized **executor agents**
- reusable **skills**
- **approval gates before active testing begins**

## Repository Structure

```text
.
├── .claude-plugin/
│   └── marketplace.json
├── plugins/
│   └── pentest/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── agents/
│       ├── docs/
│       └── skills/
├── LICENSE
└── README.md

