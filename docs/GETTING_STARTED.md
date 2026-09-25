# Getting started, step by step

Run these on **your own computer**. You need a terminal and about 10 minutes.

## 0. Prerequisites (once)

1. **Node.js 20 or newer.** Check with `node -v`. If it is missing or older,
   install the LTS version from <https://nodejs.org>.
2. **git.** Check with `git --version`.
3. **opencode**, the AI coding agent:
   ```bash
   npm install -g opencode-ai
   opencode --version
   ```
   Start `opencode` once and log in to your model provider (`/connect` inside
   opencode), then quit.

## 1. Get Agent Office

```bash
git clone https://github.com/S-Gutierrez/Agent-ui.git agent-office
cd agent-office
git checkout claude/agent-office-avatars-99xmfc
npm install
```

## 2. Try it in simulation mode (no opencode needed)

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. You'll see six **fake** agents. The yellow banner
at the top says so. Try the following:

- Click an agent to open its terminal. It has **reasoning**, **chat** and **memory** tabs.
- Wait for someone to walk to the boss desk with a `!`. Open **inbox** (top right) to see their request.
- Try **restrict & retry...**. After a few seconds the agent asks again with a narrower request.
- Try **approve always...**, edit the pattern, and confirm. Then open **rules** and edit or delete the rule.

Press `Ctrl+C` in the terminal to stop.

## 3. Make every agent always ask you

Use the ready-made config [`examples/opencode.json`](../examples/opencode.json).
Copy it into **each project** your agents work in, as `opencode.json` in the
project root. Alternatively, copy it to `~/.config/opencode/opencode.json` to
apply it to all projects.

```bash
cp examples/opencode.json /path/to/your/project/opencode.json
```

The config does two things:

- `"permission": "ask"` makes opencode ask before **every** tool action (bash,
  edit, webfetch, ...). Nothing runs silently.
- `"peerPermissions": "ask"` stops the peers plugin from auto-approving actions
  that one agent triggers in another. Its default, `"allow"`, would skip you.

Change `"name"` in the config for each agent (for example `backend` or
`frontend`). Other agents use that name to talk to it.

> Never start opencode with `--auto`. It approves everything without asking.

## 4. Start your agents

Open one terminal per agent. Give each one its own port, and run each one in
the folder of the project that agent should work on:

```bash
# terminal 1
cd /path/to/backend-project
opencode --port 4096 --hostname 127.0.0.1

# terminal 2
cd /path/to/frontend-project
opencode --port 4097 --hostname 127.0.0.1
```

Inside each opencode window, give the session a clear title (it becomes the
avatar's name) and start a task.

## 5. Start the office connected to them

In another terminal, from the `agent-office` folder:

```bash
OPENCODE_URLS=http://127.0.0.1:4096,http://127.0.0.1:4097 npm run dev
```

On Windows PowerShell:

```powershell
$env:OPENCODE_URLS="http://127.0.0.1:4096,http://127.0.0.1:4097"; npm run dev
```

Open <http://127.0.0.1:5173>. Each opencode session is now an avatar. The
simulation banner is gone, and the green dot in the top bar means the office is
connected.

If you set a password on opencode (`OPENCODE_SERVER_PASSWORD`), also set
`OPENCODE_AUTHORIZATION="Basic <base64 of opencode:yourpassword>"`.

## 6. Answering permission requests

When an agent needs something, it walks to your desk. Open **inbox**, or click
the agent. Every request shows what the agent asked for (for example
`npm publish --dry-run`). It also shows what an "always" approval would grant:
opencode's *simplified* pattern, such as `npm *`. Broad patterns are
highlighted in yellow.

| Button | What happens |
| --- | --- |
| **approve this time** | Runs this one request. |
| **approve always...** | Opens an editor with the simplified pattern, which you can **edit** (for example narrow `npm *` to `npm test*`). On confirm, it is saved as an office rule and future matching requests are approved automatically. If your edited pattern no longer covers the current request, that request is rejected and the agent is told what you do allow. |
| **restrict & retry...** | Rejects the request and tells the agent to ask again, more narrowly. You can add a hint. |
| **no** | Rejects this one request. |
| **never...** | Like "approve always", but saves a **deny** rule. Matching requests are rejected automatically from now on. |

Open **rules** (top bar) at any time to edit a rule's pattern or action, delete
it, or add a new one. Deny rules win over allow rules. Rules are saved in
`.office/permission-rules.json`, which is git-ignored.

Behind the scenes the office always answers opencode with "approve once" or
"reject", never opencode's own "always". That way every standing approval lives
in *your* rules list, where you can see and revoke it.

## 7. Agent memories (optional)

Add this to the `AGENTS.md` of each project, so agents keep a memory and
behave well when you restrict them:

```md
## Memory
You have a personal memory file at `<agent-office>/memory/<your-session-title-slug>.md`.
Read it at the start of a task; append durable learnings at the end.
Never store secrets or personal data about people in it.

## Permissions
If a permission request is rejected and you are asked for a narrower request,
retry with the most specific command or path that does the job (no wildcards
unless necessary).
```

## 8. Production mode (one port)

```bash
npm run build
OPENCODE_URLS=http://127.0.0.1:4096 npm start
# open http://localhost:4317
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Red dot in the top bar | The office server isn't running. Check the terminal where you ran `npm run dev`. |
| No avatars appear | Check that opencode is running on the ports in `OPENCODE_URLS` (`curl http://127.0.0.1:4096/session` should return JSON). Sessions older than 12 h are hidden; start a new one or set `OFFICE_SESSION_MAX_AGE_H`. |
| Agents do things without asking | Make sure `opencode.json` with `"permission": "ask"` is in the project folder (or `~/.config/opencode/`) and restart opencode. Don't use `--auto`. |
| Agents never talk to each other | Install the peers plugin (it's in the config's `plugin` list; opencode installs it on start) and give each instance a `name`. |
| Port already in use | Pick other ports, for example `--port 4098`. |
