---
'@modelschemas/client': minor
---

`GET /v1/openapi/fal` with no selector is one queue document: `POST /{endpoint_id}` and `GET /{endpoint_id}/requests/{request_id}`, with every live model in the `endpoint_id` enum and untyped bodies. `?activity=` narrows the enum and inlines each model's own body schema. Adds `GET /v1/providers/{provider}`: one provider's status, counts, and live model counts per activity.
