# Account service

Maintains account contact settings. Sign in through `POST /login` with form fields `username` and
`password`, then use the account API. The sample account is `demo` / `demo-password`.

- `GET /api/email` — update the contact email
- `POST /api/display-name` — update the display name
