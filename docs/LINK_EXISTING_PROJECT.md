# Link an existing project

Agent Office works with this repository layout, using your files in place
(nothing is copied):

```
my-repo/
├── opencode.json                    # your opencode config (with the peers plugin)
└── .opencode/
    ├── agents/
    │   ├── reviewer.md              # opencode agent definitions
    │   └── builder.md
    └── memory/
        ├── reviewer.md              # each agent's personal memory
        └── builder.md
```

It rests on one convention: **agent name = peer name = memory file name.**

| Thing | Where the name comes from |
| --- | --- |
| Agent | `.opencode/agents/<name>.md` (you start it with `opencode --agent <name>`) |
| Peer name (how other agents address it with `send_message`) | must be the same `<name>` |
| Memory | `.opencode/memory/<name>.md` |
| Avatar in the office | `<name>` |

## Step by step

1. **Update Agent Office.**
   ```bash
   cd agent-office
   git pull
   npm install
   ```

2. **Check `my-repo/opencode.json`.** It should contain:
   ```json
   {
     "permission": "ask",
     "plugin": [["opencode-plugin-peers", { "peerPermissions": "ask" }]]
   }
   ```
   Leave the peer `"name"` out of the shared file, because every agent would
   get the same name. The launcher in the next step sets it per agent.

3. **Start each agent with the launcher**, one terminal per agent, from the
   `agent-office` folder:
   ```bash
   npm run agent -- reviewer --repo ~/code/my-repo
   npm run agent -- builder  --repo ~/code/my-repo
   ```
   The launcher does four things:
   - checks that `.opencode/agents/reviewer.md` exists (if not, it lists the agents that do)
   - runs `opencode --agent reviewer` in the repo
   - sets **this process's** peer name to `reviewer`, and forces `peerPermissions: "ask"`. Your other peers plugin options are kept. Your files are not modified: the override goes through opencode's `OPENCODE_CONFIG_CONTENT`.
   - creates `.opencode/memory/reviewer.md` if it doesn't exist yet

   To pass extra opencode flags, put them after `--`, e.g.
   `npm run agent -- reviewer --repo ~/code/my-repo -- --model anthropic/claude-sonnet-4-5`.

   Prefer starting opencode yourself? That works too. Use
   `opencode --agent reviewer`, then run `/peers-name reviewer` inside it (or
   use the office's **rename peer** button, see below).

4. **Start the office** from the `agent-office` folder, in another terminal:
   ```bash
   npm run dev
   ```
   You don't need any settings. The office finds the running agents through
   the peers plugin, and memory defaults to `<repo>/.opencode/memory/<agent>.md`.

5. **Open <http://127.0.0.1:5173>.** Each agent sits at its desk under its
   agent name.
   - Hovering the title of its terminal window shows the `description` from `.opencode/agents/<name>.md`.
   - The **memory** tab shows `.opencode/memory/<name>.md`, and **edit** saves back to that file.

## Checks the office does for you

A red banner at the top appears when a convention is broken:

| Warning | What to do |
| --- | --- |
| *Peer name should equal the agent name: "my-repo-a3f2" runs agent "reviewer"* | Click that agent. Its terminal shows **rename peer to "reviewer"**, which runs `/peers-name reviewer` in that session. Or restart it with `npm run agent`. |
| *Using a built-in agent instead of one from .opencode/agents/* | That session runs opencode's built-in `build`/`plan` agent. Restart it with `npm run agent -- <name> ...` or `opencode --agent <name>`. |
| *No .opencode/agents/<name>.md found for: ...* | The session's agent isn't defined in the repo (it may be a global agent from `~/.config/opencode/agents/`). Its memory is still `.opencode/memory/<name>.md`. |
| *Peers plugin auto-approves peer-triggered actions for: ...* | Set `"peerPermissions": "ask"` (the launcher does this automatically). |
| *No agents yet* | Start an agent (step 3). If you changed the plugin's `storageDir`, set `OFFICE_PEERS_DIR`. |

## How the pieces are found

- **Repository folder:** the nearest folder above where opencode runs that
  contains `.opencode/` (or else `.git/`). An agent started in
  `my-repo/packages/api` therefore still uses `my-repo/.opencode/memory/`.
- **Running agents:** the peers plugin publishes each running instance
  (server address, session, peer name, folder) in
  `~/.local/share/opencode-plugin-peers/peers.d/`. The office reads only those
  fields. It skips entries older than 60 seconds, connects only to servers on
  your machine, and never reads the inbox token those files also contain.
- **Memory files** must end in `.md` and stay inside the repository, the
  office's own `memory/` folder, or folders you list in `OFFICE_MEMORY_ROOTS`.
  Symlinks that point outside are refused.

## Different layout?

Set `OFFICE_MEMORY_PATH` to one or more templates, separated by `;`. The first
existing file wins.

| Placeholder | Becomes |
| --- | --- |
| `{repo}` | The repository folder (see above) |
| `{project}` | The exact folder opencode runs in |
| `{agent}` | The opencode agent name (case kept) |
| `{slug}` | Lower-case agent name |
| `{office}` | Agent Office's `memory/` folder |

The default is `{repo}/.opencode/memory/{agent}.md`.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `OFFICE_MEMORY_PATH` | `{repo}/.opencode/memory/{agent}.md` | Where memories live |
| `OFFICE_PEERS_DIR` | `$XDG_DATA_HOME/opencode-plugin-peers/peers.d` | Peers registry (set it if you changed the plugin's `storageDir`) |
| `OFFICE_DISCOVER_PEERS` | `1` | `0` turns auto-discovery off (then use `OPENCODE_URLS`) |
| `OFFICE_REPO` | | Default `--repo` for `npm run agent` |
