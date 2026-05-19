# lark-bind-agent

OpenClaw **[Agent Skills](https://agentskills.io)-compatible** skill: create a dedicated agent, explicitly select or create a **Feishu/Lark** account, bind a user or chat using the `openclaw-lark` QR binding flow (`feishu_agent_bind`), then patch `openclaw.json` with dry-run and backup.

## Requirements

- OpenClaw with Feishu channel and `openclaw-lark` (or official Feishu plugin) enabled, or permission to create a new Feishu/Lark bot through `create-app`.
- Default OpenClaw config at `~/.openclaw/openclaw.json`, or set `OPENCLAW_CONFIG_PATH`.
- For a custom state directory (for example a non-default profile path), set `OPENCLAW_STATE_DIR`. New agent workspace defaults are created under that directory unless you pass `--workspace` / `--agent-dir`.
- Node.js 18+ (for built-in `fetch` in `save-qr` remote mode and `create-app`).

## Install

Clone or copy this folder into your **active agent workspace** skills directory:

```text
<workspace>/skills/lark-bind-agent/
  SKILL.md
  scripts/lark-bind-agent.mjs
```

Example:

```bash
git clone https://github.com/imjszhang/lark-bind-agent.git \
  "$HOME/.openclaw/workspace/skills/lark-bind-agent"
```

Adjust the destination if your workspace path differs.

Ensure the agent that runs this skill has `feishu_agent_bind` and Feishu messaging tools allowed. Then invoke via [skills](https://docs.openclaw.ai/tools/skills) or `/skill lark-bind-agent`.

## Tool permissions

The agent that runs this skill must be allowed to call `feishu_agent_bind`. Feishu messaging tools such as `feishu_im_user_message` or `feishu_im_bot_image` are also needed if the workflow sends the binding QR code through Feishu/Lark.

Prefer granting `feishu_agent_bind` only to the agent that performs binding, for example in that agent's `tools.alsoAllow`. Granting it globally through top-level `tools.alsoAllow` also works, but gives every agent access to the binding tool.

After updating OpenClaw config, run:

```bash
node scripts/lark-bind-agent.mjs prepare
```

Check that the output contains `"hasFeishuAgentBind": true`. If Feishu is configured and messaging tools are available, but this value is `false`, the QR binding path cannot run yet.

## Account paths

This skill does not assume a default `main` Feishu account. Choose one path for every run:

- **Existing account**: run `prepare`, pick an explicit `accountId` from the Feishu account list, bind a user/group, then dry-run and commit.
- **New dedicated account**: run `create-app`, scan/open the Feishu/Lark verification URL, store the returned App Secret as a SecretRef, then use the generated handoff file with `config --dry-run`.

`npx -y @larksuite/openclaw-lark install` and `openclaw channels login --channel feishu` are still useful global setup commands, but they can install plugins, write config, and restart the gateway. They are not the controlled dry-run path used by this skill.

## Helper commands

From the skill root, `{baseDir}` is expanded by OpenClaw when the skill runs; on the shell use the real path:

```bash
node scripts/lark-bind-agent.mjs prepare
node scripts/lark-bind-agent.mjs config --dry-run --agent-id my-agent --name "My Agent" \
  --account-id selected-account --peer-kind direct --peer-id ou_xxxx
# After explicit user confirmation only:
node scripts/lark-bind-agent.mjs config --commit ...
```

Create a new Feishu/Lark app and store the App Secret in `~/.openclaw/.env`:

```bash
node scripts/lark-bind-agent.mjs create-app --confirm-create \
  --secret-mode env --secret-env-var MY_AGENT_LARK_APP_SECRET
```

Then use the printed `credentialFile`:

```bash
node scripts/lark-bind-agent.mjs config --dry-run \
  --agent-id my-agent --name "My Agent" \
  --account-id my-agent --dedicated-account \
  --app-credential-file ~/.openclaw/credentials/lark-bind-agent-cli_xxx.handoff.json \
  --peer-kind direct --peer-id ou_xxxx
```

File-backed SecretRef storage is also supported:

```bash
node scripts/lark-bind-agent.mjs create-app --confirm-create \
  --secret-mode file \
  --secret-file-path ~/.openclaw/credentials/lark-bind-agent.secrets.json \
  --secret-file-id /my-agent/appSecret
```

Normalize a QR result from `feishu_agent_bind` when needed:

```bash
node scripts/lark-bind-agent.mjs save-qr --stdin
```

Data URLs are saved as local image files. Existing file paths are returned as-is. Plain URLs are saved as a text file by default to avoid sending QR contents to a third-party service; pass `--allow-remote-qr-service` only if you explicitly want the script to generate a PNG through the remote QR service.

## Security

- Never commit real App Secrets or tokens.
- `create-app` writes only a redacted handoff file; do not print or paste App Secret values.
- Use `--account-id` explicitly for existing accounts. For a new dedicated account, `accountId` may match `agentId`, but review it in the dry-run summary.
- `config --commit` backs up the config file before writing; review `prepare` and `--dry-run` output first.

## License

MIT
