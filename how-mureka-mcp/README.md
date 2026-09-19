# HOW Mureka MCP v0.1

A minimal, read-only remote MCP server for checking the HOW project's Mureka API connection and billing/credit state.

## v0.1 scope

Only two tools are exposed:

- `get_api_status` — confirms whether the Mureka API secret is configured.
- `get_billing` — calls Mureka's read-only `GET /v1/account/billing` endpoint.

This version intentionally does **not** expose song generation, remix, lyrics generation, uploads, or any other write/cost-incurring tools.

## Security

Never commit a Mureka API key into GitHub.

Configure it in Cloudflare Workers as a secret:

```bash
npx wrangler secret put MUREKA_API_KEY
```

The secret name must be exactly:

```text
MUREKA_API_KEY
```

## Local checks

```bash
npm install
npm run typecheck
npm run dev
```

The MCP endpoint is served by the Worker through the standard Cloudflare Agents `createMcpHandler()` transport.

## Deploy

```bash
npm install
npm run deploy
```

After deployment, use the Worker MCP endpoint in ChatGPT's custom MCP/app setup.

## Current safety rule

Do not add generation tools until:
1. Billing has been successfully read.
2. API pricing/credits are understood.
3. The user explicitly approves enabling cost-incurring tools.
