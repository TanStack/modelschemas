// End-to-end agent-auth round-trip against a running dev server (task 5.1
// acceptance): discovery → POST /agent/register (autonomous, dynamic host,
// inline Ed25519 keys) → POST /capability/execute round-tripping getSchema.
//
//   pnpm run agent-roundtrip [baseUrl]
//
// Exits non-zero on any failure. Also used as a reference client until the
// real CLI lands (task 7.5).
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const base = process.argv[2] ?? 'http://localhost:3000'

interface Discovery {
  issuer: string
  default_location: string
  algorithms: Array<string>
  endpoints: Record<string, string>
}

async function fail(step: string, response: Response): Promise<never> {
  console.error(`${step} failed: ${String(response.status)}`)
  console.error(await response.text())
  process.exit(1)
}

const discoveryResponse = await fetch(`${base}/.well-known/agent-configuration`)
if (!discoveryResponse.ok) await fail('discovery', discoveryResponse)
const discovery = (await discoveryResponse.json()) as Discovery
console.log(`discovery ok (issuer ${discovery.issuer})`)

const hostKeys = await generateKeyPair('Ed25519', { extractable: true })
const agentKeys = await generateKeyPair('Ed25519', { extractable: true })
const hostJwk = await exportJWK(hostKeys.publicKey)
const agentJwk = await exportJWK(agentKeys.publicKey)
const hostId = crypto.randomUUID()

const hostJwt = await new SignJWT({
  aud: discovery.issuer,
  host_public_key: hostJwk,
  agent_public_key: agentJwk,
})
  .setProtectedHeader({ alg: 'EdDSA', typ: 'host+jwt' })
  .setIssuer(hostId)
  .setIssuedAt()
  .setJti(crypto.randomUUID())
  .setExpirationTime('5m')
  .sign(hostKeys.privateKey)

const registerResponse = await fetch(discovery.endpoints.register ?? '', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${hostJwt}`,
  },
  body: JSON.stringify({
    name: 'roundtrip-test-agent',
    mode: 'autonomous',
    capabilities: ['getSchema'],
    host_name: 'roundtrip-host',
  }),
})
if (!registerResponse.ok) await fail('register', registerResponse)
const registration = (await registerResponse.json()) as Record<string, unknown>
const agentId =
  (registration.agent_id as string | undefined) ??
  (registration.id as string | undefined)
console.log(
  `register ok (agent ${String(agentId)}, status ${String(registration.status)})`,
)
if (!agentId) {
  console.error('no agent id in register response:', registration)
  process.exit(1)
}

// iss = host id, sub = agent id (§ the server resolves the agent by `sub`
// and cross-checks `iss` against the agent's host).
const registeredHostId = (registration.host_id as string | undefined) ?? hostId
const agentJwt = await new SignJWT({
  aud: discovery.default_location,
  capabilities: ['getSchema'],
})
  .setProtectedHeader({ alg: 'EdDSA', typ: 'agent+jwt' })
  .setIssuer(registeredHostId)
  .setSubject(agentId)
  .setIssuedAt()
  .setJti(crypto.randomUUID())
  .setExpirationTime('2m')
  .sign(agentKeys.privateKey)

const executeResponse = await fetch(discovery.default_location, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${agentJwt}`,
  },
  body: JSON.stringify({
    capability: 'getSchema',
    arguments: {
      provider: 'anthropic',
      activity: 'chat',
      endpointId: 'v1/messages',
      kind: 'input',
    },
  }),
})
if (!executeResponse.ok) await fail('execute', executeResponse)
const executed = (await executeResponse.json()) as {
  data?: { contentHash?: string; schema?: unknown }
  contentHash?: string
  schema?: unknown
}
const payload = executed.data ?? executed
if (!payload.schema || !payload.contentHash) {
  console.error(
    'execute returned no schema:',
    JSON.stringify(executed).slice(0, 500),
  )
  process.exit(1)
}
console.log(
  `execute ok — getSchema round-tripped (contentHash ${String(payload.contentHash).slice(0, 12)}…)`,
)

// Native protected route (task 5.2): /v1/agents/me with a fresh agent JWT
// (jti is replay-protected, so the execute JWT can't be reused).
const meJwt = await new SignJWT({ aud: discovery.default_location })
  .setProtectedHeader({ alg: 'EdDSA', typ: 'agent+jwt' })
  .setIssuer(registeredHostId)
  .setSubject(agentId)
  .setIssuedAt()
  .setJti(crypto.randomUUID())
  .setExpirationTime('2m')
  .sign(agentKeys.privateKey)
const meResponse = await fetch(`${base}/v1/agents/me`, {
  headers: { Authorization: `Bearer ${meJwt}` },
})
if (!meResponse.ok) await fail('agents/me', meResponse)
const me = (await meResponse.json()) as {
  agent?: { agentId?: string; capabilities?: Array<string> }
}
if (me.agent?.agentId !== agentId) {
  console.error('agents/me returned wrong agent:', me)
  process.exit(1)
}
console.log(
  `agents/me ok (capabilities: ${(me.agent.capabilities ?? []).join(', ')})`,
)
