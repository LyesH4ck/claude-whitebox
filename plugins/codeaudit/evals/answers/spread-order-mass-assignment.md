# Answer key — spread-order-mass-assignment

Tests spread order on a write: two handlers persist request data, and the position of the spread decides
whether a server-set field survives.

**Planted true positive** — `routes.js`, `POST /members`: `data: { role: 'member', workspaceId: …, invitedBy: …,
...req.body }`. Later keys win, so a body carrying `role: "owner"` or `workspaceId: "<other workspace>"`
overwrites the server-set values. Any signed-in member creates an owner, or a member in another workspace.
High (authenticated → capped at high): privilege escalation and cross-tenant write through mass assignment.

**Planted safe case** — `routes.js`, `PATCH /members/me`: `pick(req.body, PROFILE_FIELDS)` allowlists the
writable fields before the update; `role` and `workspaceId` cannot reach persistence. Reporting it is the
false positive a "request body reaches update()" matcher makes. (`PATCH /members/:id/role` is owner-gated by
its own `preHandler` and scoped to the session's workspace — also not a finding.)
