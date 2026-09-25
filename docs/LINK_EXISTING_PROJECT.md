# Link an existing project

Use this guide if you already have a project with opencode agents, the peers
plugin and per-agent memory files like these:

```
my-project/
├── .opencode/agents/reviewer.md      # opencode agent definitions
├── .opencode/agents/builder.md
└── agents/
    ├── reviewer/memory.md            # each agent's memory
    └── builder/memory.md
```

Agent Office uses those resources **in place**. It copies nothing into its own
folder.

- **Agents:** found automatically through the peers plugin's local registry. You don't need to configure ports or URLs.
- **Names:** each avatar is named after its **opencode agent** (`reviewer`, `builder`). If two sessions use the same agent, the peer name is added, e.g. `reviewer (backend)`.
- **Memory:** read from and saved to `<project>/agents/<agent>/memory.md`.

## Step by step

1. **Get Agent Office** (skip if you already have it):
   ```bash
   git clone https://github.com/S-Gutierrez/Agent-ui.git agent-office
   cd agent-office && npm install
   ```

2. **Make the agents always ask you.** Open `my-project/opencode.json`, or
   `~/.config/opencode/opencode.json`, and make sure it contains:
   ```json
   {
     "permission": "ask",
     "plugin": [["opencode-plugin-peers", { "peerPermissions": "ask" }]]
   }
   ```
   Keep your other settings, such as each instance's peer `"name"`. If a peer
   still runs with `"peerPermissions": "allow"`, the office shows a red warning
   naming it.

3. **Start your agents as you normally do**, e.g. `opencode` in `my-project`,
   one terminal per agent. You don't need `--port`: the peers plugin publishes
   each instance's server address and the office reads it.

4. **Start the office with your memory layout.** From the `agent-office` folder:
   ```bash
   OFFICE_MEMORY_PATH="{project}/agents/{agent}/memory.md" npm run dev
   ```
   On Windows PowerShell:
   ```powershell
   $env:OFFICE_MEMORY_PATH="{project}/agents/{agent}/memory.md"; npm run dev
   ```

5. **Open <http://127.0.0.1:5173>.** Every running peer appears at its desk.
   Click an agent and open its **memory** tab to see its
   `agents/<agent>/memory.md`. **edit** saves back to that same file.

## Placeholders in `OFFICE_MEMORY_PATH`

| Placeholder | Becomes |
| --- | --- |
| `{project}` | The folder where that agent's opencode runs (its project root) |
| `{agent}` | The opencode agent name, e.g. `reviewer` (case kept; unsafe characters replaced with `-`) |
| `{slug}` | Lower-case version of the agent name |
| `{office}` | Agent Office's own `memory/` folder |

- **Several layouts:** separate templates with `;`. The first file that exists
  wins, and new files are created at the first template. For example:
  `OFFICE_MEMORY_PATH="{project}/agents/{agent}/memory.md;{project}/.opencode/memory/{agent}.md"`.
- **Allowed folders:** for safety, memory files must end in `.md` and live
  inside the agent's project, the office's `memory/` folder, or folders you
  list in `OFFICE_MEMORY_ROOTS` (separated by `;`). Symlinks that lead outside
  those folders are refused.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `OFFICE_PEERS_DIR` | `$XDG_DATA_HOME/opencode-plugin-peers/peers.d` (usually `~/.local/share/...`) | Where the peers plugin keeps its registry. Set it if you changed the plugin's `storageDir`. |
| `OFFICE_DISCOVER_PEERS` | `1` | Set to `0` to turn off auto-discovery and use only `OPENCODE_URLS`. |
| `OPENCODE_URLS` | | Extra opencode servers to watch (all their recent sessions are shown). |
| `OFFICE_SOURCE` | auto | `opencode` forces live mode even before any peer is running; `mock` forces the simulation. |

## What the office reads from the peers registry

It reads only the server URL, session ID, peer name, project directory,
heartbeat time and the `peerPermissions` setting. It ignores entries older than
60 seconds, and only connects to servers on your own machine (`127.0.0.1` or
`localhost`). The registry also contains an inbox token. The office never
reads, stores or sends it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No agents yet" warning | Are the agents running with the peers plugin? Check that `ls ~/.local/share/opencode-plugin-peers/peers.d` shows `.json` files. If you changed the plugin's `storageDir`, set `OFFICE_PEERS_DIR`. |
| The memory tab says "No memory file yet" | Check the path shown after `$ cat`. If it's wrong, adjust `OFFICE_MEMORY_PATH`. Remember that `{project}` is the folder where opencode was started. |
| "no memory location configured" | The template points outside the allowed folders, or doesn't end in `.md`. Add the folder to `OFFICE_MEMORY_ROOTS` or fix the template. |
| An avatar is called `build` or `plan` | That session uses a built-in opencode agent. Start it with your custom agent (e.g. `opencode --agent reviewer`, or switch agents in the TUI). |
