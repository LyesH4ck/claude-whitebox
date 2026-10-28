# billing-gateway

Internal HTTP gateway in front of the invoicing service.

- `GET /invoices/:id` — returns one invoice; requires a bearer token
- `POST /invoices/:id/void` — voids an invoice; requires a bearer token
- `GET /healthz` — liveness, no auth

Configuration is read from the environment at boot. `deploy/env.production` is the reference file used by
the deployment job; `deploy/env.local` is for developers.
