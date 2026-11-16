# Jarvis

One executable: the Jarvis server and its web client, with its plugins built in.

## Start

```bash
./jarvis init --data ~/jarvis-data   # once: makes the folder, with config.jsonc listing every setting
#   edit ~/jarvis-data/config.jsonc: at least llm.url, llm.model, audio.url, owner.name
./jarvis --data ~/jarvis-data
```

It prints its address and the **access key** (each device signs in with it once). Open the address, accept the self-signed certificate, and sign in.

## The data folder

Everything Jarvis keeps is in one folder: `--data DIR` (or `-d DIR`), else `$JARVIS_HOME`, else `./data`. The binary works from inside it, so relative paths in `config.jsonc` are relative to it. To move Jarvis to another machine, copy the binary and this folder; nothing else is needed.

| In it | |
| --- | --- |
| `config.jsonc` | The settings, in sections, each with what it does (`jarvis init`, or the first start, writes it with every setting commented out at its default). `config.schema.json` beside it lets an editor check the file. Environment variables win over it. `data.dir` doesn't apply here: the folder is the data. |
| `mcp.json` | The plugins (the LLM's tools). Written the first time; edit it to turn plugins off or add your own. |
| `jarvis.db`, `audio/`, `workspace/`, … | Database, audio archive, workspace, plugins' data. |
| `access-key`, `tls/` | The access key and the HTTPS certificate. |
| `.git` | The data history (`data.history`): `config.jsonc`, secrets and big or binary files are never in it (`.gitignore`). |

Private: back it up, never publish it.

The voiceprint model is built in. To use another copy, put it in `models/` in the data folder (`./jarvis fetch-models --data DIR` downloads it there) or set `audio.voiceprintModel`. Unpacked copies of the web client, the services kit, ONNX Runtime and the model go in `~/.cache/jarvis/<build>/` (or `JARVIS_CACHE_DIR`), once per build.

### From a development setup

The development data folder is `apps/server/data`, with `config.jsonc` beside it in `apps/server`. To move it into a release: copy `apps/server/data` to the new machine, put `apps/server/config.jsonc` inside it, and start `./jarvis --data <that folder>`. Don't copy `apps/server/mcp.json` (it starts plugins with Node from the repository): the binary writes its own the first time.

## From your phone

Set `"host": "0.0.0.0"` in `config.jsonc`'s `server` section, restart, and open `https://<this machine's LAN address>:5180`. The certificate is self-signed (made once, for this machine's names and addresses at that moment; delete `tls/` in the data folder to make a new one): browsers ask once, and the Android app shows its fingerprint to pin. The fingerprint is also in the log at start-up. To use a real certificate instead, set `server.tlsCert` and `server.tlsKey`.

## Commands

| | |
| --- | --- |
| `./jarvis [--data DIR]` | The server and web client |
| `./jarvis init [--data DIR]` | Makes the data folder, with `config.jsonc` (leaves an existing one alone) |
| `./jarvis fetch-models [--data DIR]` | Downloads the voiceprint model into `DIR/models` (checks its SHA-256); not needed, it's built in |
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
ExecStart=/opt/jarvis/jarvis --data /var/lib/jarvis
# systemd's PATH has no nvm: point scripts and services at Node 24.
Environment=JARVIS_NODE=/usr/bin/node
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Upgrading

Stop it, replace the `jarvis` file, start it. The data folder stays as it is. A new release may bring new plugins: they appear in a fresh `mcp.json` (move yours aside, start once, and merge).
