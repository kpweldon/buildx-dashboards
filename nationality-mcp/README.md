# BuildX Nationality API

A small server that runs on the office NAS and gives Claude a nationality
lookup tool — on the phone, on the desktop app, and on claude.ai, all from the
same box.

It exposes the same data two ways:

| Endpoint | For |
| --- | --- |
| `POST /mcp` | Claude. This is the MCP endpoint you point a custom connector at. |
| `GET /api/nationality?name=Buz` | Plain JSON, CORS enabled — callable from the BuildX dashboard HTML. |
| `GET /api/country?code=US` | Country reference data. |
| `GET /health` | Liveness check. Never requires auth. |

Data comes from [nationalize.io](https://nationalize.io) (name → likely
countries) and [restcountries.com](https://restcountries.com) (country detail).
Country names and flags for the prediction results are bundled locally, so a
prediction needs exactly one upstream call.

No dependencies. No build step. Node 20+ or Docker.

---

## The one thing that trips everybody up

**Claude does not call your NAS from your phone.** When you use a connector,
the request is made from Anthropic's servers, not from the device you're
holding. A LAN address like `http://192.168.1.50:8787` will never work as a
connector URL, even while you're standing in the office on the same Wi-Fi.

So the NAS needs a public HTTPS URL. The clean way to get one — without
forwarding ports or exposing the NAS directly — is a **Cloudflare Tunnel**:
the NAS makes an outbound connection to Cloudflare, and Cloudflare gives you a
hostname that routes back down it. Your firewall stays shut. It's free.

Step 3 below covers it.

---

## 1. Get it onto the NAS

Copy the `nationality-mcp/` folder to the NAS (SMB share, `git clone`, or
Synology File Station — whatever you normally do).

## 2. Start it

```bash
cd nationality-mcp
cp .env.example .env      # then edit .env — see below
docker compose up -d
```

Check it came up:

```bash
curl http://localhost:8787/health
```

You want `{"status":"ok", ...}`.

### What goes in `.env`

Both values are optional, but set `AUTH_TOKEN` before you expose this to the
internet in step 3.

- `AUTH_TOKEN` — a shared secret. Anything random; `openssl rand -hex 32` is
  fine. Once set, every request except `/health` must send
  `Authorization: Bearer <token>`.
- `NATIONALIZE_API_KEY` — optional. Without it, nationalize.io allows 100
  lookups per day per IP address, which is the whole office sharing one
  bucket. With a key, the limit follows the key.

No Docker on the NAS? `npm start` works too — it's plain Node, no install step.

## 3. Give it a public HTTPS URL (Cloudflare Tunnel)

You need a domain on Cloudflare for this. If BuildX already has one, use a
subdomain like `nationality.buildx-yourdomain.com`.

```bash
# on the NAS
cloudflared tunnel login
cloudflared tunnel create buildx-nationality
cloudflared tunnel route dns buildx-nationality nationality.yourdomain.com
cloudflared tunnel run --url http://localhost:8787 buildx-nationality
```

Then run it as a service so it survives a NAS reboot:

```bash
cloudflared service install
```

Synology and QNAP can also run `cloudflare/cloudflared` as a container
alongside this one — same result, managed from the Docker UI.

Confirm from off the office network (phone on cellular is the honest test):

```bash
curl https://nationality.yourdomain.com/health
```

## 4. Connect it to Claude

Once, on claude.ai — it then syncs to every Claude you're signed into,
including the phone app.

1. **Settings → Connectors → Add custom connector**
2. URL: `https://nationality.yourdomain.com/mcp`
3. If you set an `AUTH_TOKEN`, add the header
   `Authorization: Bearer <your token>`
4. Save, then enable the connector in a chat.

Ask Claude *"what nationality is the name Buz likely to be?"* — it should call
`predict_nationality` and come back with ranked countries.

### Claude Code / this repo

For terminal sessions, `.mcp.json` in the repo root already points at the
tunnel hostname. Change the URL there if yours differs.

---

## Tools Claude gets

| Tool | Does |
| --- | --- |
| `predict_nationality` | One first name → ranked countries with probabilities. |
| `predict_nationality_batch` | Up to 10 names per call; one bad name doesn't sink the batch. |
| `get_country_info` | ISO code or country name → official name, flag, region, capital, population, languages, currencies. |

## Using it from the dashboards

CORS is open, so the existing HTML can call it directly:

```js
const res = await fetch(
  'https://nationality.yourdomain.com/api/nationality?name=Buz',
  { headers: { Authorization: 'Bearer ' + TOKEN } },
);
const { predictions } = await res.json();
```

Note the token would be visible in page source — if the dashboards are public,
run without `AUTH_TOKEN` and rely on the tunnel's access rules instead, or
proxy the call.

## Tests

```bash
npm test
```

23 tests, no network required — the upstreams are stubbed. Covers the MCP
handshake, protocol version negotiation, tool dispatch, batch partial failure,
rate-limit handling, auth gating, and CORS.

---

## One caution worth reading

These predictions are population statistics about a *name string* — how often
that name appears in each country. They are not a fact about any individual.
The name "Buz" being 41% US-associated says nothing about where a particular
Buz is from.

That matters more than usual here, because BuildX is a housing and
construction business. Under the Fair Housing Act, national origin is a
protected class, and inferring it for leads, applicants, or tenants — even
informally, even just to segment ad audiences — is the kind of thing that
creates real legal exposure. Aggregate audience research and content work are
fine. Scoring individual people is not.

The tool descriptions Claude sees carry this caveat too, so it should push back
if asked to use it that way.
