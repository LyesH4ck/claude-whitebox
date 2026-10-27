# team-directory

Member directory for a workspace. Any signed-in member can create a member record for a newcomer and edit
their own profile; only owners can change roles.

- `POST /members` — create a member (signed-in member)
- `PATCH /members/me` — update your own profile
- `PATCH /members/:id/role` — change a member's role (owner only)
