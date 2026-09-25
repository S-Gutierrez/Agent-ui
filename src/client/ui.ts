// In-game "terminal" windows and the boss inbox. All agent-provided text is
// inserted with textContent - never innerHTML - so agent output cannot inject
// markup into the page.

import type { Agent, LogEntry, OfficeSnapshot, PermissionRequest } from "../shared/types.ts";
import { api } from "./api.ts";
import { permissionCard } from "./permissions-ui.ts";

type Tab = "reasoning" | "chat" | "memory";

const REASONING_KINDS = new Set<LogEntry["kind"]>(["reasoning", "tool", "system", "peer"]);
const CHAT_KINDS = new Set<LogEntry["kind"]>(["user", "text"]);
const PREFIX: Record<LogEntry["kind"], string> = {
  reasoning: "think",
  tool: "tool ",
  system: "sys  ",
  peer: "peer ",
  user: "boss ",
  text: "agent",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export class Logs {
  private byAgent = new Map<string, LogEntry[]>();
  private listeners = new Set<(e: LogEntry) => void>();
  private loaded = new Set<string>();

  add(e: LogEntry): void {
    const list = this.list(e.agentId);
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e;
    else {
      list.push(e);
      if (list.length > 500) list.shift();
    }
    this.listeners.forEach((l) => l(e));
  }

  list(agentId: string): LogEntry[] {
    let l = this.byAgent.get(agentId);
    if (!l) this.byAgent.set(agentId, (l = []));
    return l;
  }

  /** Merge server-side history the first time a window opens. */
  async ensureHistory(agentId: string): Promise<void> {
    if (this.loaded.has(agentId)) return;
    this.loaded.add(agentId);
    const history = await api.log(agentId).catch(() => []);
    const list = this.list(agentId);
    const seen = new Set(list.map((e) => e.id));
    list.unshift(...history.filter((e) => !seen.has(e.id)));
    list.sort((a, b) => a.at - b.at);
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export class TerminalWindow {
  readonly root = el("div", "term");
  private readonly titleEl = el("span", "term-title");
  private readonly tabs = new Map<Tab, HTMLButtonElement>();
  private readonly body = el("div", "term-body");
  private readonly banner = el("div", "term-banner");
  private readonly form = el("form", "term-input");
  private readonly input = el("input");
  private tab: Tab = "reasoning";
  private unsubscribe: () => void;
  private agent: Agent;
  private permissions: PermissionRequest[] = [];

  constructor(
    agent: Agent,
    private readonly logs: Logs,
    private readonly onClose: () => void,
    private readonly onFocus: (w: TerminalWindow) => void,
    initialTab: Tab = "reasoning",
  ) {
    this.agent = agent;
    const bar = el("div", "term-bar");
    const dots = el("span", "term-dots");
    for (const c of ["#ff5f56", "#ffbd2e", "#27c93f"]) {
      const d = el("i");
      d.style.background = c;
      dots.append(d);
    }
    const close = el("button", "term-close", "x");
    close.title = "Close";
    close.type = "button";
    close.onclick = () => this.close();
    bar.append(dots, this.titleEl, close);

    const tabBar = el("div", "term-tabs");
    for (const t of ["reasoning", "chat", "memory"] as Tab[]) {
      const b = el("button", "term-tab", t);
      b.type = "button";
      b.onclick = () => this.show(t);
      this.tabs.set(t, b);
      tabBar.append(b);
    }

    const prompt = el("span", "term-prompt", "boss@office:~$");
    this.input.placeholder = "message this agent...";
    this.input.maxLength = 20_000;
    this.input.autocomplete = "off";
    this.form.append(prompt, this.input);
    this.form.onsubmit = (ev) => {
      ev.preventDefault();
      void this.send();
    };

    this.root.append(bar, tabBar, this.banner, this.body, this.form);
    this.root.addEventListener("pointerdown", () => this.onFocus(this));
    makeDraggable(this.root, bar);
    this.unsubscribe = logs.onEntry((e) => {
      if (e.agentId === this.agent.id && this.tab !== "memory") this.renderEntry(e);
    });
    this.setAgent(agent);
    void logs.ensureHistory(agent.id).then(() => this.show(this.tab));
    this.show(initialTab);
  }

  get agentId(): string {
    return this.agent.id;
  }

  setAgent(agent: Agent): void {
    this.agent = agent;
    const status = agent.status === "needs_review" ? "waiting for you" : agent.status;
    this.titleEl.textContent = `${agent.name} - ${status}`;
    this.root.dataset.status = agent.status;
  }

  setPermissions(all: PermissionRequest[]): void {
    const mine = all.filter((p) => p.agentId === this.agent.id);
    if (mine.map((p) => p.id).join() === this.permissions.map((p) => p.id).join()) return;
    this.permissions = mine;
    this.banner.replaceChildren(...mine.map((p) => permissionCard(p)));
    this.banner.hidden = mine.length === 0;
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.tabs.forEach((b, t) => b.classList.toggle("active", t === tab));
    this.form.hidden = tab !== "chat";
    this.body.replaceChildren();
    this.body.dataset.tab = tab;
    if (tab === "memory") {
      void this.renderMemory();
      return;
    }
    if (tab === "chat") {
      this.body.append(
        el("div", "term-line sys", "# You are talking to an AI agent. Its replies are machine-generated and may be wrong."),
      );
    }
    for (const e of this.logs.list(this.agent.id)) this.renderEntry(e, false);
    this.scrollToEnd();
    if (tab === "chat") this.input.focus();
  }

  close(): void {
    this.unsubscribe();
    this.root.remove();
    this.onClose();
  }

  private renderEntry(e: LogEntry, scroll = true): void {
    const kinds = this.tab === "chat" ? CHAT_KINDS : REASONING_KINDS;
    if (!kinds.has(e.kind)) return;
    const existing = this.body.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.id)}"]`);
    const line = existing ?? el("div", `term-line ${e.kind}`);
    line.dataset.id = e.id;
    const ts = el("span", "ts", time(e.at));
    const tag = el("span", "tag", `[${PREFIX[e.kind]}]`);
    const text = el("span", "txt", e.text);
    line.replaceChildren(ts, tag, text);
    if (!existing) this.body.append(line);
    if (scroll) this.scrollToEnd();
  }

  private scrollToEnd(): void {
    const b = this.body;
    requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.input.disabled = true;
    try {
      await api.send(this.agent.id, text);
    } catch (err) {
      this.body.append(el("div", "term-line error", `! could not send: ${(err as Error).message}`));
    } finally {
      this.input.disabled = false;
      this.input.focus();
    }
  }

  private async renderMemory(): Promise<void> {
    const agentId = this.agent.id;
    this.body.append(el("div", "term-line sys", "loading memory..."));
    let mem: { content: string; exists: boolean; file: string };
    try {
      mem = await api.memory(agentId);
    } catch (err) {
      this.body.replaceChildren(el("div", "term-line error", `! ${(err as Error).message}`));
      return;
    }
    if (this.tab !== "memory" || this.agent.id !== agentId) return;

    const header = el("div", "mem-header");
    header.append(el("span", "", `$ cat memory/${mem.file}`));
    const edit = el("button", "mem-btn", mem.exists ? "edit" : "create");
    edit.type = "button";
    header.append(edit);

    const view = el("div", "mem-view");
    if (!mem.exists) view.append(el("div", "term-line sys", "# No memory file yet for this agent."));
    for (const line of mem.content.split("\n")) {
      const cls = /^#{1,6}\s/.test(line) ? "md-h" : /^\s*[-*]\s\[[ x]\]/i.test(line) ? "md-task" : /^\s*[-*]\s/.test(line) ? "md-li" : /^>/.test(line) ? "md-quote" : "";
      view.append(el("div", `mem-line ${cls}`, line || " "));
    }
    this.body.replaceChildren(header, view);

    edit.onclick = () => {
      const area = el("textarea", "mem-edit");
      area.value = mem.content;
      area.spellcheck = false;
      const save = el("button", "mem-btn", "save");
      const cancel = el("button", "mem-btn", "cancel");
      save.type = cancel.type = "button";
      const status = el("span", "mem-status");
      save.onclick = async () => {
        save.disabled = true;
        try {
          await api.saveMemory(agentId, area.value);
          this.show("memory");
        } catch (err) {
          status.textContent = `! ${(err as Error).message}`;
          save.disabled = false;
        }
      };
      cancel.onclick = () => this.show("memory");
      const bar = el("div", "mem-header");
      bar.append(el("span", "", `editing memory/${mem.file}`), status, save, cancel);
      this.body.replaceChildren(bar, area);
      area.focus();
    };
  }
}

export class Inbox {
  readonly root = el("div", "inbox");
  private readonly list = el("div", "inbox-list");
  private readonly head = el("div", "inbox-head");
  private open = false;

  constructor(private readonly onOpenAgent: (id: string) => void) {
    const close = el("button", "term-close", "x");
    close.type = "button";
    close.onclick = () => this.toggle(false);
    this.head.append(el("span", "", "Boss desk - requests"), close);
    this.root.append(this.head, this.list);
    this.root.hidden = true;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.root.hidden = !this.open;
  }

  private readonly cards = new Map<string, HTMLElement>();
  private readonly empty = el("div", "term-line sys", "Nobody is waiting for you.");

  /** Keeps existing cards (and any pattern being edited) across snapshots. */
  update(snapshot: OfficeSnapshot): void {
    const names = new Map(snapshot.agents.map((a) => [a.id, a.name]));
    const live = new Set(snapshot.permissions.map((p) => p.id));
    for (const [id, card] of this.cards) {
      if (!live.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }
    for (const p of snapshot.permissions) {
      if (this.cards.has(p.id)) continue;
      const wrap = el("div", "inbox-item");
      const who = el("button", "inbox-agent", names.get(p.agentId) ?? p.agentId);
      who.type = "button";
      who.onclick = () => this.onOpenAgent(p.agentId);
      wrap.append(who, permissionCard(p));
      this.cards.set(p.id, wrap);
      this.list.append(wrap);
    }
    if (this.cards.size) this.empty.remove();
    else this.list.replaceChildren(this.empty);
  }
}

function makeDraggable(win: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (ev) => {
    if ((ev.target as HTMLElement).closest("button")) return;
    const startX = ev.clientX - win.offsetLeft;
    const startY = ev.clientY - win.offsetTop;
    handle.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      win.style.left = `${Math.max(0, Math.min(innerWidth - 80, e.clientX - startX))}px`;
      win.style.top = `${Math.max(0, Math.min(innerHeight - 40, e.clientY - startY))}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
