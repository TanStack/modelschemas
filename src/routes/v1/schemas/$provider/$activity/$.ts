import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { jsonError } from '#/server/admin.ts'
import {
  cachedJson,
  cachedText,
  catalogCache,
  versionedSchemaCache,
} from '#/server/http-cache.ts'
import { getModelDetail, listModelsCatalog } from '#/server/catalog.ts'
import { getEndpointSchema, knownEndpointIds } from '#/server/schemas-api.ts'
import { emitTypesModule, modelIdsKey, typesEtag } from '#/server/typegen.ts'

export const Route = createFileRoute('/v1/schemas/$provider/$activity/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env, { replica: true })
        if (!(activities as ReadonlyArray<string>).includes(params.activity)) {
          return jsonError(
            404,
            'unknown_activity',
            `Unknown activity '${params.activity}'. Valid activities: ${activities.join(', ')}.`,
          )
        }
        const activity = params.activity as Activity
        const endpointId = params._splat ?? ''
        const url = new URL(request.url)
        const kindParam = url.searchParams.get('kind') ?? 'input'
        if (kindParam !== 'input' && kindParam !== 'output') {
          return jsonError(
            400,
            'invalid_kind',
            `Invalid kind '${kindParam}'. Valid kinds: input, output.`,
          )
        }
        const version = url.searchParams.get('version') ?? undefined
        const format = url.searchParams.get('format') ?? 'json'
        if (format !== 'json' && format !== 'types') {
          return jsonError(
            400,
            'invalid_format',
            `Invalid format '${format}'. Valid formats: json, types.`,
          )
        }
        const optionalStyle = url.searchParams.get('optional') ?? 'exact'
        if (optionalStyle !== 'exact' && optionalStyle !== 'undefined') {
          return jsonError(
            400,
            'invalid_optional',
            `Invalid optional '${optionalStyle}'. Valid styles: exact, undefined.`,
          )
        }

        const value = await getEndpointSchema(
          db,
          params.provider,
          activity,
          endpointId,
          kindParam,
          version,
        )
        if (value === null) {
          const valid = await knownEndpointIds(db, params.provider, activity)
          const model = await getModelDetail(db, params.provider, endpointId)
          const modelHint =
            model?.activity !== null &&
            model?.activity !== undefined &&
            model.activity !== activity
              ? ` Model '${model.rawId}' is activity '${model.activity}', not '${activity}'.`
              : ''
          return jsonError(
            404,
            'unknown_schema',
            `No ${kindParam} schema${version ? ` at version '${version}'` : ''} for endpoint '${endpointId}' (${params.provider}/${activity}).${modelHint} ` +
              (valid.length > 0
                ? `Valid endpoint ids: ${valid.join(', ')}. A listed model rawId also aliases onto that activity's generation route.`
                : `No endpoints synced for this provider/activity yet — try POST /v1/admin/sync/${params.provider} or check /v1/status.`),
          )
        }
        if (format === 'types') {
          const schema = value.schema
          const record =
            typeof schema === 'object' &&
            schema !== null &&
            !Array.isArray(schema)
              ? (schema as Record<string, unknown>)
              : {}
          const overlayModel =
            kindParam === 'input' &&
            typeof record.properties === 'object' &&
            record.properties !== null &&
            'model' in record.properties
          // Prefer same-activity ids so an image schema isn't unioned with
          // chat models. Providers that still leave activity null fall back
          // to the full catalog (otherwise the overlay would be empty).
          const catalog = overlayModel
            ? await listModelsCatalog(db, { provider: params.provider })
            : undefined
          const matching =
            catalog === undefined
              ? undefined
              : catalog.models.filter((row) => row.activity === activity)
          const overlayIds =
            catalog === undefined
              ? undefined
              : matching !== undefined && matching.length > 0
                ? matching
                : catalog.models
          const modelIds =
            value.aliasedFrom !== undefined
              ? [value.aliasedFrom]
              : overlayIds?.map((m) => m.rawId)
          const text = emitTypesModule({
            provider: params.provider,
            endpointId: value.endpointId,
            kind: kindParam,
            contentHash: value.contentHash,
            schema: record,
            optionalStyle,
            sourceUrl: `${url.origin}${url.pathname}?kind=${kindParam}`,
            ...(modelIds !== undefined ? { modelIds } : {}),
          })
          const cache =
            version !== undefined
              ? versionedSchemaCache(value.createdAt)
              : catalogCache()
          return cachedText(request, text, 'text/typescript; charset=utf-8', {
            etag: typesEtag(
              value.contentHash,
              optionalStyle,
              modelIds !== undefined ? modelIdsKey(modelIds) : undefined,
            ),
            ...cache,
          })
        }
        const cache =
          version !== undefined
            ? versionedSchemaCache(value.createdAt)
            : catalogCache()
        return cachedJson(request, value, {
          // Aliased (model-id) reads pin `model` on the body; hash that
          // view so two models sharing a route don't 304 each other.
          ...(value.aliasedFrom === undefined
            ? { etag: value.contentHash }
            : {}),
          ...cache,
        })
      },
    },
  },
})
