# Optional WorkOS sign-in

Aperture Chat can let [WorkOS AuthKit](https://workos.com/docs/authkit) run
single sign-on instead of connecting each identity provider directly. It is
optional and off by default: a deployment that never saves WorkOS keys never
contacts WorkOS.

Aperture Chat has no shared WorkOS account. Whoever runs an instance enters
their **own** WorkOS client ID and API key, so WorkOS bills that deployment and
each fork keeps its own users, organizations, and connections. At the time of
writing, staging environments are free; in production, AuthKit is free up to
1 million monthly active users and enterprise SSO connections are billed per
connection. Check [WorkOS pricing](https://workos.com/pricing) before you plan
a rollout.

## When to use it

| Choose | When |
| --- | --- |
| A direct OIDC provider (Entra ID, Okta, Google, Keycloak) | You serve one organization and can register an app at its identity provider. |
| WorkOS AuthKit | You want WorkOS to host the sign-in page and handle each customer's SAML or OIDC connection, including onboarding their IT team through the WorkOS Admin Portal. |

Both kinds can coexist: each is an SSO configuration with its own allowed
domains.

## How it fits

A WorkOS configuration is an ordinary SSO configuration with a different
protocol. Everything after the provider returns an identity is shared with
OIDC, so domains, provisioning, group mapping, MFA, and enforcement behave the
same way.

```text
Browser ──Continue with SSO──▶ GET /api/auth/sso/{config}/authorize
                                 │ signed state + PKCE (+ typed email as login_hint)
                                 ▼
                     WorkOS AuthKit hosted sign-in
                     (the organization's SAML/OIDC connection,
                      plus any methods enabled in the WorkOS dashboard)
                                 │ ?code=…&state=…
                                 ▼
                     GET /api/auth/sso/callback   (shared with OIDC)
                                 │ POST /user_management/authenticate  (API key, PKCE verifier)
                                 │ verify access token with /sso/jwks/{client_id}
                                 ▼
                     shared sign-in rules → Aperture Chat session
```

| Piece | Where |
| --- | --- |
| WorkOS client: authorize URL, code redemption, token verification, Test connection checks | `services/api/app/core/workos.py` (plain HTTPS, no WorkOS SDK) |
| Protocol dispatch in authorize, the shared callback, and sign-in readiness | `services/api/app/routes/auth.py` (`LIVE_SSO_PROTOCOLS`, `_redeem_authorization_code`) |
| Test connection for WorkOS cards | `services/api/app/routes/admin.py` (`_test_workos_sso_config`) |
| Owner form: Protocol › WorkOS AuthKit | `apps/web/src/components/PlatformConsole.tsx` (`SsoRequirementsPanel`) |
| Admin form and card: Identity provider › WorkOS (AuthKit) | `apps/web/src/components/AdminConsole.tsx` (`SsoCreateForm`, `SsoConfigCard`) |
| Sign-in screen: Sign in with WorkOS, login hint | `apps/web/src/components/AuthScreen.tsx` |
| Tests | `services/api/tests/test_workos_sso.py` and the matching web tests |

The configuration record:

| `SsoConfig` field | WorkOS value |
| --- | --- |
| `provider` | `workos` |
| `settings.protocol` | `WORKOS` |
| `client_id` | the WorkOS client ID (`client_…`) |
| vaulted secret | the WorkOS API key (`sk_…`), encrypted like every SSO secret and never returned to the browser |
| `issuer_url` | empty: WorkOS has one fixed API address |
| `settings.workos_organization_id` | optional; WorkOS selects this organization for every sign-in |
| `settings.group_claim` | `roles` by default, so WorkOS role slugs can be mapped to workspace groups |
| `settings.domains`, `jit_provisioning`, `enforced`, `require_platform_mfa`, `mapped_groups` | the same controls every provider uses |

No environment variables are required. `APERTURE_WORKOS_API_BASE_URL`
(default `https://api.workos.com`) exists only so tests can point the API at
the WorkOS emulator.

## Set it up

1. **Aperture Chat:** Platform console › Org Settings › Single Sign-On ›
   Protocol › **WorkOS AuthKit (your WorkOS account)**. Copy the redirect URI
   (`https://your-instance.example/api/auth/sso/callback`).
2. **WorkOS dashboard › Redirects:** add the redirect URI. Production
   environments accept only HTTPS.
3. **WorkOS dashboard › API Keys:** copy the client ID and an API key. Use the
   staging environment's keys while you test.
4. **WorkOS dashboard › Organizations:** create the organization, add and
   verify its domain, and set up its SSO connection (or invite its IT team
   through the Admin Portal). Copy the organization ID if every person in this
   workspace belongs to that organization.
5. **Aperture Chat:** enter the WorkOS client ID, the optional organization ID,
   and the allowed email domains. Paste the API key last, choose **Save SSO**,
   then **Test connection**. API key, Client ID, Organization, and Sign-in
   readiness must pass.
6. **WorkOS dashboard › Redirects:** add the **Initiate login URI** the panel
   shows after saving (`…/api/auth/sso/{config-id}/authorize`). WorkOS uses it
   when a sign-in has to start from Aperture Chat.
7. Sign in as a test person from a private window, then turn on
   **Enforce SSO for these domains** when everyone can sign in.

Administrators can create the same configuration in Admin console › SSO ›
Add SSO configuration › Identity provider › **WorkOS (AuthKit)** when the
platform owner allows SSO management. To serve several workspaces from one
WorkOS account, use the same keys in each workspace's configuration and give
each its own organization ID and allowed domains.

The step-by-step lesson is *Single sign-on with WorkOS* in the owner
documentation library and the owner PDF guide.

## Security model

- The authorize request carries the HMAC-signed state and a PKCE S256
  challenge; the callback rejects tampered or expired state.
- The code is redeemed server to server with the API key and the PKCE
  verifier. The browser never sees the API key or a WorkOS token.
- The WorkOS access token is verified against the signing keys WorkOS
  publishes for the configured client ID, and its subject must equal the
  returned user. Its organization and roles are used only after that check.
- With an organization ID configured, a sign-in from any other WorkOS
  organization is refused.
- Then the shared rules apply: the email must be on an allowed domain, an
  explicitly unverified email is refused, an existing account stays bound to
  its first SSO identity, JIT provisioning follows the configuration, mapped
  groups follow the WorkOS roles, and the optional platform authenticator and
  enforcement behave as for OIDC.
- Every outbound call goes through the same egress guard as OIDC.

## Known limits

- An account that already signed in through another provider is bound to that
  provider's identity. Its first WorkOS sign-in is refused with "This email
  now belongs to a different identity at the provider." until an administrator
  resets the account once; the next WorkOS sign-in binds it to WorkOS.
- Signing out of Aperture Chat ends the Aperture Chat session only. The
  person's WorkOS session continues until it expires or they sign out of
  WorkOS.
- Directory Sync (SCIM through WorkOS) is not connected. Use the built-in SCIM
  endpoint for provisioning.

## Test locally without a WorkOS account

The official emulator from the WorkOS CLI implements the same API:

```bash
npx workos@latest emulate --port 4100 --interactive
```

Start the API with `APERTURE_WORKOS_API_BASE_URL=http://localhost:4100` in a
local environment, save a WorkOS configuration with the API key the emulator
prints, and sign in. The CLI emulator only redirects to `localhost`; the
`@workos/emulate` package's `allowedRedirectHosts` option allows other test
host names. `apps/web/scripts/walkthroughs/sso-workos.cjs` drives the full
loop, including creating the organization and person through the WorkOS API.
