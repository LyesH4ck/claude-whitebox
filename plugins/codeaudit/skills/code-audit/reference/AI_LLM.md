# AI / LLM / Agent Reference — the model-delegation trust layer

Mounted by the **ai-agent-auditor** (OWASP **A04 Insecure Design** + OWASP LLM Top-10). Reach for this when a
language model participates in a **trust-sensitive decision**: chatbots/assistants, RAG, persistent agent
memory, tool-calling loops, MCP servers/clients, prompt assembly from untrusted input, or code that **acts on
model output**. The important flow is **untrusted content → model or memory → capability, authority, or sink**.

Ordinary boundaries (transport, access control, query construction, filesystem, output rendering) still apply —
route those to the normal auditors. This file owns the **model-specific delegation layer**.

- **Prompt injection alone is not a finding.** Require a **code-level boundary failure**: content reaches
  another principal’s context, invokes authority the requester lacks, discloses data they can’t read, or drives
  a sink they can’t reach directly. Point to the code that **grants authority, trusts output, writes durable
  state, or feeds a sink** — not to persuasive text.
- **Model output, memory, tool descriptions, and MCP responses are UNTRUSTED inputs** (treat like any source in
  the shared SKILL). A guardrail *prompt* is not a security boundary — count only deterministic checks,
  resource-scoped authorization, isolation, binding, and constrained credentials.
- **Verdict from code.** Provider/model/renderer behavior not in the repo → coverage gap.

## Draw four maps first

Before hunting, enumerate: (1) each **execution identity** the agent can act under; (2) each **capability/tool**;
(3) every **writable context or memory** source; (4) each **output destination/sink**. Then connect the
principal at the *start* to the authority at the *end*. Start at side-effecting tools and work backward through
dispatcher → schema → confirmation → model context → retrieval → ingestion.

## Context, retrieval & memory attack classes

**Indirect prompt injection through retrieved/ingested content**
An attacker writes a RAG document, indexed page, file, email, issue body, tool response, or metadata that enters
**a different principal’s** model context. Trace who can write each source, how retrieval scopes it, whose
session consumes it, and **what capability is enabled there**. The defect is a missing deterministic control
(isolation, resource authorization, binding to the consuming principal’s intent) — not the text itself.

**Cross-session / cross-tenant context bleed**
Conversation history, embeddings, retrieval results, or **prompt caches keyed too broadly**. Verify the tenant/
ACL filter is in the **query itself** and every cache key. A tenant field on the object isn’t enforcement if an
alternate query, shared cache, or batch path omits it. Seeds:
`rg -n -i 'embedding|vector|retriev|rag|history|conversation|cache.?key|namespace'`.

**Persistent memory poisoning**
Attacker-controlled content or model summaries written into **memory that later shapes another task/user/
privileged session**. Review who may create/update/merge/delete memory; provenance and tenant scope; whether
low-trust observations become durable **instructions** vs facts; whether retrieval distinguishes user
preferences from tool policy. (Memory a user saves for their **own** later intentional use is not a cross-
boundary finding.)

**Prompt role & provenance confusion**
Prompt assembly lets untrusted text **impersonate** a system message, prior turn, tool result, policy, or memory
record — string concatenation, untyped history, caller-controlled `role` fields, serialization round-trips that
lose source labels. Confirm the forged provenance changes a **deterministic** trust decision or reaches a
capability. Seeds: `rg -n -i 'role\s*[:=]\s*.system|system_prompt|messages\.push|f".*\{.*\}.*"|\+ *user_input'`.

## Tool & action attack classes

**Tool-argument injection into a downstream sink**
Model-produced arguments reach SQL, shell, file, URL-fetch, or a privileged API **without handler-side
validation**. Treat the tool schema as input parsing, then follow each field from the decoded call to the sink.
Structured output narrows *shape* — it does not establish authorization, safe paths, safe URLs, or query
semantics. (Hand the sink trace to injection/ssrf auditors; own the **model-arg → sink** linkage.)

**Excessive agency & confused-deputy authority**
The agent uses a **service identity or broad credential** while the tool handler does **not re-check the
requesting principal’s permission** on the named resource. Verify both the effective identity *and* whether the
caller could do that exact operation through the normal product interface. A shared credential **with enforced
per-user query scope** is not a defect.

**Action-confirmation & approval binding**
A user approves one described action but execution uses **changed arguments, a different resource/principal, or a
later model turn**. Also: attacker-controlled content causes a side effect under a **victim’s** valid authority
without the victim’s intentional request/approval. Confirm intent/approval binds the **normalized tool name,
full argument object, requester, target, amount, expiry, and batch membership** — across retries and resumed
sessions.

**Tool-schema / dispatcher disagreement**
The schema accepts aliases, extra fields, duplicate keys, coercions, nested free-form objects, or out-of-range
values the dispatcher/handler interprets **differently**. Compare schema validation, canonicalization, generated
bindings, and handler defaults. Re-validate where values become **resource selectors** or security options.

**Unbounded delegated action loops**
A bounded request enqueues repeated spend/send/mutation/external-API work with **no per-request budget,
per-action authorization, cancellation, or idempotency**. Confirm impact on shared cost, quotas, other users, or
durable state (code-level accounting — do not exhaust a live service).

## MCP & sub-agent trust classes

**Sub-agent / MCP trust inheritance** — a delegated task receives the **full** session/credentials/memory/
capabilities rather than least authority. Check the principal/tenant carried into each call, capability
narrowing, credential audience, and whether delegated results are treated as untrusted on return.
**MCP server / tool identity confusion** — calls/results routed by attacker-influenceable server names, tool
names, request IDs, or resource URIs rather than the authenticated connection and outstanding request. Can two
servers claim the same tool identity? Does reconnect rebind? Can one server’s response satisfy another’s pending
call?
**MCP metadata as policy** — tool descriptions, resource metadata, prompts, or schemas from an MCP peer are
trusted as **authorization**. They can guide the model but cannot grant capability — find the deterministic
allowlist, server-identity check, and handler authorization that stay authoritative when metadata conflicts.

## Output & disclosure attack classes

**Insecure output rendering** — model output reaches an executing HTML/Markdown/template/URL/command sink
without the sink’s required encoding/policy (hand browser rendering to CLIENT_SIDE / xss-auditor; own the
**model-output → sink** linkage). **Sensitive context extraction** — the assembled context contains credentials,
another user’s data, private source, or policy values, and user-influenced output exposes them. Read prompt
assembly and data-fetch code. Disclosure of generic instructions that cross no data boundary is not a finding.

## Verdict & false-positive discipline

`vulnerable` names the crossed boundary and observable result: attacker, affected principal or shared resource,
**execution identity**, target, and the unauthorized/unrequested action or disclosure. `safe` when a
deterministic check/isolation/binding/constrained-credential enforces the boundary after arguments are final and
before every side effect.
- **A guardrail prompt / "the model was instructed not to" is never a control.** Count only deterministic code.
- **For confused-deputy**, prove the handler lacks requester-and-resource authorization AND the attacker can’t
  perform the action normally. **For action-binding**, prove attacker-controlled content caused an action under
  the victim’s authority they didn’t approve — generic authorization does not establish intent.
- **For memory/retrieval**, cite BOTH the attacker-controlled write AND the later cross-principal read/privileged
  decision. A shared record with no reachable consumer is not enough.
- Provider/model/renderer behavior outside source → coverage gap, not a confirmed verdict.
