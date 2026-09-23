# JAI Connect Read Protocol v1

This is an app-agnostic, read-only JSON envelope. It defines no
product-specific data fields or authorization by itself.
The existing verified identity and `jai_live_` flow are separate.

Request:

```json
{
  "version": 1,
  "request_id": "UUID",
  "app_id": "UUID",
  "capability": "customer.profile.read",
  "customer": { "external_subject": "stable-app-customer-id" }
}
```

Response:

```json
{
  "version": 1,
  "request_id": "same-request-UUID",
  "capability": "customer.profile.read",
  "observed_at": "2026-01-01T00:00:00Z",
  "data": {}
}
```

The four initial capability values are `customer.profile.read`,
`customer.subscription.read`, `billing.payment.read`, and `diagnostics.read`.
Both envelopes require exactly the shown top-level keys; the request's
`customer` object requires only `external_subject`. UUIDs use the standard
8-4-4-4-12 form. `external_subject` is nonempty, at most 200 characters, and
contains no control characters. `observed_at` is an RFC 3339 timestamp with a
timezone. `data` is a JSON object, with no capability-specific schema in v1.

Validation limits: request JSON at most 4 KiB; response JSON at most 16 KiB;
`data` nesting at most five levels, arrays at most 50 items, objects at most
64 members, keys at most 100 characters, and strings at most 2048 characters.
Non-finite numbers and object keys `__proto__`, `constructor`, and `prototype`
are rejected. The validators in `src/read-v1.ts` implement these bounds.

An endpoint is unavailable until explicitly configured and enabled by an
organization admin. Configuration never grants access: a future JAI backend
client must derive `app_id` and `external_subject` from trusted identity state,
then require both the configured endpoint and the app's enabled capability
before making a read request. It must also validate the public network route
at call time. Browser callers have no access to the endpoint resolver.


## Outbound request signature

JAI signs the exact UTF-8 JSON request body with Ed25519 in compact JWS form:
`base64url(header).base64url(claims).base64url(signature)`. Send it as
`Authorization: Bearer <JWS>` over HTTPS. The header is exactly
`{"alg":"EdDSA","typ":"JWT","kid":"<public-key-thumbprint>"}`. The
signature covers the ASCII bytes of the first two dot-separated segments.

The claims are `iss`, `aud`, `version`, `request_id`, `app_id`, `capability`,
`external_subject`, `iat`, `exp`, `jti`, and `body_sha256`. `iss` is the trusted
JAI JWKS URL; `aud` is the exact configured connector endpoint URL. The v1
request values are copied into the same-named claims. `iat` and `exp` are Unix
seconds, with `exp - iat` at most 300; JAI currently issues 120-second tokens.
`jti` is a fresh UUID. `body_sha256` is unpadded base64url SHA-256 of the exact
request body bytes, not a re-serialized JSON object.

JAI's public key endpoint is `/functions/v1/jai-connect-jwks` on its trusted
Supabase project. It returns a standard JWKS `{"keys":[...]}`; each public
JWK contains `kty:"OKP"`, `crv:"Ed25519"`, `x` (32-byte public key encoded
as unpadded base64url), `alg:"EdDSA"`, `use:"sig"`, and `kid`. `kid` is the
unpadded base64url SHA-256 JWK thumbprint of the UTF-8 bytes of
`{"crv":"Ed25519","kty":"OKP","x":"<x>"}`. Private JWK `d` is never
published.

Receiving backends must pin the expected JAI issuer/JWKS URL and their own
exact endpoint URL. Never follow a token-supplied key URL. Verify the Ed25519
signature with the matching public `kid`, then compare every claim and the raw
body hash; reject expired tokens, future `iat` beyond 30 seconds, and lifetimes
over five minutes. Atomically reserve `(iss, kid, jti)` until `exp` in durable
storage before returning data; an existing reservation is a replay. Accept
only POST to the configured read endpoint. The TypeScript verifier requires a
`reserveReplay` callback; Node can import the public JWK, while PHP/WordPress
can verify the detached signature using libsodium and the decoded `x` bytes.

JAI keeps `JAI_CONNECT_SIGNING_KEYS` as a Supabase Edge secret, not in
PostgreSQL. Its value is a JSON array of one to three private Ed25519 JWKs
(`kty`, `crv`, `x`, `d`); the first key signs new requests and all keys are
published as public JWKs. During rotation, add the new key first, retain the
old one through the maximum token lifetime plus JWKS cache time, then remove
it. This signing identity is separate from every app's `jai_live_` credential.
