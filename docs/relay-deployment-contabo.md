# Deploying the relay on the Contabo server (notes, not yet done)

This is a **document only**. Nothing in this repository deploys anything. These are the steps the operator (Christian,
or someone he trusts) runs by hand when the relay is to go live. Placeholders are written like `<this>`.

Facts assumed (from the project notes): the cloud server is reached with the SSH alias `stark-cloud` from the home
server, apps live in `/srv/apps/<service>`, and ingress is only through a Cloudflare tunnel (no published ports).
Check each assumption on the server before relying on it.

## 0. Before you start

- The relay is stateless and tiny (a few MB of RAM per hundred connections). A shared server is fine.
- Do not touch other apps' containers, networks or volumes. Everything below uses a new folder, a new image and
  a new container named `starkllm-relay`.
- The official instance is `wss://relay.starkllm.com`. Self-hosters use the same steps with their own host name.

## 1. Put the code on the server

```bash
ssh stark-cloud
sudo mkdir -p /srv/apps/starkllm-relay && sudo chown "$USER" /srv/apps/starkllm-relay
cd /srv/apps/starkllm-relay
git clone --depth 1 --branch <release tag or commit> https://github.com/StarkChristian/StarkLLM.git src
```

Deploy a tagged release or a reviewed commit, never an unreviewed branch. Only the `relay/` folder is built.

## 2. Build the image

```bash
cd /srv/apps/starkllm-relay/src
docker build -t starkllm-relay:local relay
docker image inspect starkllm-relay:local --format '{{.Id}}'    # note the id in the deployment log
```

The image runs as the non-root user `node`, needs no volumes and no secrets, and works with a read-only root file system.

## 3. Compose file

```bash
cp src/relay/docker-compose.example.yml docker-compose.yml
```

Edit `docker-compose.yml`:

- `networks.tunnel.name` / `external`: the Docker network that the server's existing `cloudflared` container is on
  (`docker network ls`, `docker inspect <cloudflared container>`). If cloudflared runs on the host instead of in a
  container, replace the network by `ports: ["127.0.0.1:8787:8787"]`; never publish on `0.0.0.0`.
- Leave `RELAY_TRUSTED_IP_HEADER: cf-connecting-ip` only if all traffic really comes through the tunnel. Otherwise remove
  the line (a client could spoof the header).

Start it:

```bash
docker compose up -d
docker compose ps
docker compose logs --tail 20          # expect {"ev":"start"} and {"ev":"listening",...}
docker exec starkllm-relay node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

## 4. Cloudflare tunnel ingress

Add a public hostname to the existing tunnel (Cloudflare Zero Trust dashboard > Networks > Tunnels > the tunnel >
Public Hostname), or in a locally managed `config.yml`:

```yaml
ingress:
  - hostname: relay.starkllm.com
    service: http://starkllm-relay:8787      # container name on the shared network; or http://127.0.0.1:8787
    originRequest:
      noTLSVerify: false
  # ... existing entries ...
  - service: http_status:404
```

Notes:

- WebSockets work through Cloudflare tunnels without extra switches. Make sure *WebSockets* are enabled for the zone
  (Network settings), which is the default.
- The DNS record `relay.starkllm.com` is a proxied CNAME to `<tunnel id>.cfargotunnel.com`; the dashboard creates it
  when you add the public hostname. This is the only DNS change, and it is made by the owner, not by a script.
- Cloudflare terminates TLS. The PC and the apps refuse a relay URL that is not `wss://`.
- Do **not** put the relay behind Cloudflare Access or a challenge page: the apps cannot solve them. Use Cloudflare's
  rate-limiting / WAF rules only for the path prefix `/v1/` with generous values (the relay has its own limits).
- Cloudflare's idle timeout for WebSockets is around 100 seconds without traffic; the relay pings every 30 seconds, which
  keeps connections open.

## 5. Check from outside

```bash
curl -s https://relay.starkllm.com/healthz
# {"status":"ok","version":"0.1.0","uptime_s":...,"mailboxes":0}
curl -s -o /dev/null -w '%{http_code}\n' https://relay.starkllm.com/v1/phone?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
# 404 (no PC with this id is connected) — correct
```

Then pair a phone with a test PC build (the PC side is the next step of the plan).

## 6. Operations

- **Updating:** `git -C src fetch && git -C src checkout <new tag> && docker build -t starkllm-relay:local src/relay &&
  docker compose up -d`. Connected PCs reconnect by themselves within seconds; phones reconnect on the next use.
- **Rollback:** tag the previous image before building (`docker tag starkllm-relay:local starkllm-relay:prev`), then point the
  compose file at `:prev`.
- **Logs:** `docker compose logs`. They contain event names such as `phone_connected`, `limit_hit` and a reason, nothing
  else (no IP addresses, ids or content). Rotation is limited by the compose logging options (3 x 5 MB).
- **Monitoring:** poll `https://relay.starkllm.com/healthz` from an uptime monitor; the `mailboxes` number is the count
  of connected PCs. Alert on failure of the endpoint, not on the number.
- **Capacity:** a mailbox with a few phones is a handful of sockets. Raise the container's `mem_limit` and the limits in the
  environment variables (`relay/README.md`) if the number of PCs grows into the thousands.
- **Backups:** there is nothing to back up. The compose file and the commit id are the whole configuration.
- **Incident (suspected abuse):** `docker compose stop` is safe: PCs and phones simply reconnect when it is back. No user
  data is lost because none is stored. Tighten the limits before opening it again.

## 7. What Cloudflare sees, and a second domain

Cloudflare terminates TLS for `relay.starkllm.com`. It can see connection metadata (IP addresses, times, the path with the
routing id, frame sizes in 256-byte steps, the relay's JSON control messages that contain the PC's *public* key and a
signature) but never content: all questions, answers, documents and file names are end-to-end encrypted with Noise between
the phone and the PC. The full table and the reasoning are in section 9.2a of `docs/remote-access-design.md`; the owner
decided on 2026-11-15 that this is acceptable.

The owner has other domains (for example `homomorphicprivacy.com`). The relay does not need one. A second domain could be
useful for things that should live outside the product domain and outside the tunnel, if and when wanted: a public status
page for the relay, the published audit notes and `security.txt`, the signed list of release hashes, or a standby relay
host name for the apps to fall back to. None of this is configured here.

## 8. Privacy and legal notes for the operator

- The relay processes IP addresses in memory while connections are open (needed to apply limits) and does not write them
  anywhere. Cloudflare, as the tunnel provider, sees connection metadata under its own terms; mention it in the
  privacy policy of the app.
- No message content is available to the operator. The privacy policy and imprint for the store listings are a separate
  task of the owner (see the design document, section 11 of the proposal).

## 9. Self-hosting

Anyone can run the same image; in the PC app the relay URL is a setting, and a QR code carries the relay URL, so paired
phones follow the PC's choice. For a home network, a `ws://` relay on `localhost` is accepted for development only.
