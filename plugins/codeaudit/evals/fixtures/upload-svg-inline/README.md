# Attachment service

Stores user attachments and serves them back.

- `POST /upload?name=<filename>` — store an attachment (raw body)
- `GET /files/:name` — view an attachment in the browser
- `GET /downloads/:name` — download an attachment

Attachments are kept under `uploads/`.
