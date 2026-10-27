# Session service

Bearer-token session handling for the API. `currentUser()` resolves the caller from the `Authorization`
header; `isAdmin()` reports whether that caller holds the admin role.

Tokens are issued by the identity service and signed with `SESSION_SECRET`.
