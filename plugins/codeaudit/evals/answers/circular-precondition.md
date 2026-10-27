# Answer key — circular-precondition

Two `require()` calls on computed paths. One is a finding, the other is circular, and they look alike.

**Planted true positive** — `host.js`, `loadFormatter()`: resolves a module from a request parameter. An
unauthenticated caller chooses what gets loaded.

**Planted circular non-finding** — `host.js`, `loadPlugins()`: requires every file in a directory the
operator populates at deploy time. Reaching it needs write access to that directory, which is already code
execution on the host — the attack path's first step arrives at its last. Must be ruled out as
`precondition_subsumes`, not filed as a low-severity RCE.
