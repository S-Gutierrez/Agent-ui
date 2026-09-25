// Permission request card (five choices) and the editable rules panel.
// As everywhere in the client, agent-provided strings go through textContent.

import { evaluate, isBroadPattern, type Decision, type PermissionRule, type RuleAction } from "../shared/permissions.ts";
import type { PermissionRequest } from "../shared/types.ts";
import { api } from "./api.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

function code(text: string, broad = isBroadPattern(text)): HTMLElement {
  const c = el("code", broad ? "pat broad" : "pat", text);
  if (broad) c.title = "Broad pattern: grants much more than this single request";
  return c;
}

/** A permission request with the boss's five choices. */
export function permissionCard(p: PermissionRequest): HTMLElement {
  const card = el("div", "perm");
  const permission = p.permission ?? "permission";
  const asked = p.patterns?.length ? p.patterns : [p.title];
  const suggested = p.always?.length ? p.always : asked;

  const head = el("div", "perm-title");
  head.append(el("span", "perm-kind", p.kind === "question" ? "question" : permission));
  if (p.kind === "question") {
    head.append(el("span", "", ` ${p.title}`));
    card.append(head, el("div", "perm-hint", "Answer it in the agent's chat tab or in the opencode TUI."));
    return card;
  }
  asked.forEach((a) => head.append(" ", code(a, false)));
  card.append(head);

  const grant = el("div", "perm-hint");
  grant.append("an \"always\" approval would grant: ");
  suggested.forEach((s) => grant.append(code(s), " "));
  if (suggested.some((s) => isBroadPattern(s))) grant.append(el("span", "warn", "! broad - consider narrowing it"));
  card.append(grant);

  const actions = el("div", "perm-actions");
  const editor = el("div", "perm-editor");
  editor.hidden = true;
  const status = el("div", "perm-hint");

  const send = async (decision: Decision, opts: { patterns?: string[]; message?: string } = {}) => {
    card.querySelectorAll("button, input, textarea").forEach((x) => ((x as HTMLButtonElement).disabled = true));
    status.textContent = "sending...";
    try {
      await api.decide(p.id, decision, opts);
      status.textContent = "done";
    } catch (err) {
      status.textContent = `! ${(err as Error).message}`;
      card.querySelectorAll("button, input, textarea").forEach((x) => ((x as HTMLButtonElement).disabled = false));
    }
  };

  const openPatternEditor = (action: RuleAction) => {
    const decision: Decision = action === "allow" ? "always" : "never";
    const list = el("div", "pat-list");
    const coverage = el("div", "perm-hint");
    const rows: HTMLInputElement[] = [];
    const refresh = () => {
      const pats = rows.map((r) => r.value.trim()).filter(Boolean);
      rows.forEach((r) => r.classList.toggle("broad", isBroadPattern(r.value)));
      const rules = pats.map((pattern, i) => ({ id: String(i), permission, pattern, action, createdAt: 0 }));
      const hit = evaluate(rules, { permission, patterns: p.patterns ?? [] });
      coverage.textContent =
        action === "allow"
          ? hit
            ? "This request is covered: it runs now, and future matches are approved automatically."
            : "This request is NOT covered by these patterns: it will be rejected and the agent asked to retry within them."
          : "Matching requests will be rejected automatically from now on.";
    };
    const addRow = (value: string) => {
      const row = el("div", "pat-row");
      const input = el("input", "pat-input");
      input.value = value;
      input.maxLength = 500;
      input.spellcheck = false;
      input.oninput = refresh;
      rows.push(input);
      row.append(
        input,
        button("x", "mini", () => {
          rows.splice(rows.indexOf(input), 1);
          row.remove();
          refresh();
        }, "remove"),
      );
      list.append(row);
    };
    const fill = (values: string[]) => {
      rows.length = 0;
      list.replaceChildren();
      values.forEach(addRow);
      refresh();
    };
    fill(suggested);

    editor.replaceChildren(
      el("div", "perm-editor-title", `${action === "allow" ? "Approve always" : "Never allow"} - ${permission} pattern(s), editable (* = anything, ? = one char):`),
      list,
      el("div", "perm-quick"),
      coverage,
    );
    const quick = editor.querySelector(".perm-quick")!;
    quick.append(
      button("use exact request", "mini", () => fill(asked)),
      button("use suggested", "mini", () => fill(suggested)),
      button("+ pattern", "mini", () => {
        addRow("");
        rows.at(-1)?.focus();
        refresh();
      }),
    );
    editor.append(
      button(action === "allow" ? "confirm approve always" : "confirm never", `perm-btn ${action === "allow" ? "always" : "never"}`, () => {
        const patterns = rows.map((r) => r.value.trim()).filter(Boolean);
        if (!patterns.length) {
          coverage.textContent = "! add at least one pattern";
          return;
        }
        void send(decision, { patterns });
      }),
      button("cancel", "mini", () => (editor.hidden = true)),
    );
    editor.hidden = false;
    rows[0]?.focus();
  };

  const openRestrict = () => {
    const area = el("textarea", "perm-msg");
    area.placeholder = `Optional hint for the agent, e.g. "only ${asked[0] ?? "the exact command"}" or "read-only, no deletes"`;
    area.maxLength = 2000;
    editor.replaceChildren(
      el("div", "perm-editor-title", "Reject and ask the agent to retry with a narrower, more specific request:"),
      area,
      button("send back", "perm-btn restrict", () => void send("restrict", { message: area.value })),
      button("cancel", "mini", () => (editor.hidden = true)),
    );
    editor.hidden = false;
    area.focus();
  };

  actions.append(
    button("approve this time", "perm-btn once", () => void send("once"), "Allow this single request"),
    button("approve always...", "perm-btn always", () => openPatternEditor("allow"), "Allow now and in future - you choose the pattern"),
    button("restrict & retry...", "perm-btn restrict", openRestrict, "Reject and ask the agent to ask again with a narrower request"),
    button("no", "perm-btn no", () => void send("no"), "Reject this single request"),
    button("never...", "perm-btn never", () => openPatternEditor("deny"), "Reject now and in future - you choose the pattern"),
  );
  card.append(actions, editor, status);
  return card;
}

/** Lists the boss's standing rules; every rule can be edited or deleted. */
export class RulesPanel {
  readonly root = el("div", "inbox rules");
  private readonly list = el("div", "inbox-list");
  private lastKey = "";
  private open = false;

  constructor() {
    const head = el("div", "inbox-head");
    head.append(el("span", "", "Permission rules"), button("x", "term-close", () => this.toggle(false)));
    const intro = el(
      "div",
      "perm-hint rules-intro",
      "Standing answers to agents' permission requests. deny wins over allow. Requests that match no rule come to the boss desk.",
    );
    this.root.append(head, intro, this.list, this.addForm());
    this.root.hidden = true;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.root.hidden = !this.open;
  }

  update(rules: PermissionRule[]): void {
    const key = JSON.stringify(rules);
    // Do not clobber an edit in progress.
    if (key === this.lastKey || this.list.contains(document.activeElement)) return;
    this.lastKey = key;
    const rows = rules.map((r) => this.row(r));
    if (!rows.length) rows.push(el("div", "term-line sys", "No rules yet - use \"approve always\" or \"never\" on a request."));
    this.list.replaceChildren(...rows);
  }

  private row(r: PermissionRule): HTMLElement {
    const row = el("div", "rule-row");
    const action = actionSelect(r.action);
    const permission = el("input", "rule-perm");
    permission.value = r.permission;
    permission.maxLength = 64;
    const pattern = el("input", "pat-input");
    pattern.value = r.pattern;
    pattern.maxLength = 500;
    pattern.spellcheck = false;
    const mark = () => pattern.classList.toggle("broad", isBroadPattern(pattern.value));
    pattern.oninput = mark;
    mark();
    const status = el("span", "perm-hint");
    const save = button("save", "mini", async () => {
      try {
        await api.updateRule(r.id, { action: action.value as RuleAction, permission: permission.value, pattern: pattern.value });
        status.textContent = "saved";
        (document.activeElement as HTMLElement | null)?.blur();
      } catch (err) {
        status.textContent = `! ${(err as Error).message}`;
      }
    });
    const del = button("delete", "mini danger", async () => {
      try {
        await api.deleteRule(r.id);
      } catch (err) {
        status.textContent = `! ${(err as Error).message}`;
      }
    });
    row.append(action, permission, pattern, save, del, status);
    return row;
  }

  private addForm(): HTMLElement {
    const form = el("div", "rule-row rule-add");
    const action = actionSelect("allow");
    const permission = el("input", "rule-perm");
    permission.placeholder = "bash";
    const pattern = el("input", "pat-input");
    pattern.placeholder = "npm test*";
    const status = el("span", "perm-hint");
    form.append(
      action,
      permission,
      pattern,
      button("add rule", "mini", async () => {
        try {
          await api.addRule({ action: action.value as RuleAction, permission: permission.value || "*", pattern: pattern.value });
          pattern.value = "";
          status.textContent = "added";
        } catch (err) {
          status.textContent = `! ${(err as Error).message}`;
        }
      }),
      status,
    );
    return form;
  }
}

function actionSelect(value: RuleAction): HTMLSelectElement {
  const s = el("select", "rule-action");
  for (const a of ["allow", "deny"] as const) {
    const o = el("option", "", a);
    o.value = a;
    s.append(o);
  }
  s.value = value;
  return s;
}
