# Jarvis

One executable: the Jarvis server and its web client, with its plugins built in.

## Start

```bash
cp .env.example .env        # then edit it: at least LLM_URL, LLM_MODEL, AUDIOCPP_URL, OWNER_NAME
./jarvis fetch-models       # once: the 28 MB voiceprint model, into ./models
./jarvis
```

It prints its address and the **access key** (each device signs in with it once). Open the address, accept the self-signed certificate, and sign in.

Everything it keeps is in the folder you start it from:

| Path | |
| --- | --- |
| `.env`, `.env.local` | Configuration (`.env.local` wins). Every setting of `apps/server/.env` works. |
| `data/` | Database, audio archive, workspace, access key, HTTPS certificate (`data/tls`). Private: back it up, never publish it. |
| `mcp.json` | The plugins (the LLM's tools). Written the first time; edit it to turn plugins off or add your own. |
| `models/` | The voiceprint model (`./jarvis fetch-models`). |

Unpacked copies of the web client, the services kit and ONNX Runtime go in `~/.cache/jarvis/<build>/` (or `JARVIS_CACHE_DIR`), once per build.

## From your phone

Set `HOST=0.0.0.0` in `.env`, restart, and open `https://<this machine's LAN address>:5180`. The certificate is self-signed (made once, for this machine's names and addresses at that moment; delete `data/tls` to make a new one): browsers ask once, and the Android app shows its fingerprint to pin. The fingerprint is also in the log at start-up. To use a real certificate instead, set `TLS_CERT` and `TLS_KEY`.

## Commands

| | |
| --- | --- |
| `./jarvis` | The server and web client |
| `./jarvis fetch-models` | Downloads the voiceprint model (checks its SHA-256) |
| `./jarvis version` | Version, commit and build date |
| `./jarvis plugin <name>` | One built-in plugin, on stdio (how `mcp.json` starts them) |

## What the machine needs

Nothing for the server itself. Some features use programs on the machine:

| Feature | Needs |
| --- | --- |
| Speech, replies | audio.cpp (`AUDIOCPP_URL`) and llama.cpp's `llama-server` (`LLM_URL`), as in development |
| Scripts and services (sandboxed) | **Node.js 24** (on `PATH`, or `JARVIS_NODE`) and **bubblewrap** (`bwrap`). Node's permission model is half their sandbox, so they never run on the binary's own runtime. Services that use npm packages also need `npm`. |
| Data history | `git` |
| Self-signed HTTPS | `openssl` (once, to make the certificate) |
| Browser plugin, web search without an API key | Google Chrome (`BROWSER_EXECUTABLE`) |

## As a service (systemd)

```ini
# /etc/systemd/system/jarvis.service
[Unit]
Description=Jarvis
After=network-online.target

[Service]
User=jarvis
WorkingDirectory=/opt/jarvis
ExecStart=/opt/jarvis/jarvis
# systemd's PATH has no nvm: point scripts and services at Node 24.
Environment=JARVIS_NODE=/usr/bin/node
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Upgrading

Stop it, replace the `jarvis` file, start it. `data/`, `.env` and `mcp.json` stay as they are. A new release may bring new plugins: they appear in a fresh `mcp.json` (move yours aside, start once, and merge).
