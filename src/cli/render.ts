import type { AvailableCommand, SessionConfigOption, SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import { isTTY, makeStyles, tildify, truncate, termWidth } from "../shared/ui.js";
import { MarkdownStream } from "./markdown.js";

export const st = makeStyles(isTTY());
/** Alias histórico usado en el resto del CLI. */
export const color = st;

/** Nombres de las herramientas del puente según cómo las expone cada agente. */
const BRIDGE_TOOL = /^(?:mcp__relay__|relay_)(\w+)$/;
/** Herramientas internas del agente que no aportan nada al usuario. */
const HIDDEN_TOOLS = new Set(["ToolSearch"]);

export type LocalKind = "read" | "write" | "edit" | "exec" | "search" | "list";

const LOCAL_LABEL: Record<LocalKind, string> = {
  read: "lee",
  write: "escribe",
  edit: "edita",
  exec: "ejecuta",
  search: "busca",
  list: "lista",
};

/** Dibuja en la terminal lo que hace el agente durante un turno. */
export class Renderer {
  availableCommands: AvailableCommand[] = [];
  configOptions: SessionConfigOption[] = [];
  currentMode?: string;
  private midLine = false;
  /** Último tipo de bloque dibujado, para separar respuesta y herramientas. */
  private lastBlock: "message" | "activity" | null = null;
  private stream: "message" | "thought" | null = null;
  private md: MarkdownStream;
  private tools = new Map<string, { name: string; bridged: boolean; shown: boolean }>();
  private turnStart = 0;
  private toolCount = 0;

  constructor(private showThoughts: boolean) {
    this.md = new MarkdownStream(st, (s) => this.write(s));
  }

  private write(s: string) {
    if (!s) return;
    process.stdout.write(s);
    this.midLine = !s.endsWith("\n");
  }

  /** Asegura que lo siguiente empiece en una línea nueva. */
  newline() {
    if (this.stream === "message") this.md.flush();
    if (this.midLine) this.write("\n");
    this.stream = null;
  }

  line(s = "") {
    this.newline();
    this.write(s + "\n");
  }

  beginTurn() {
    this.turnStart = Date.now();
    this.toolCount = 0;
    this.tools.clear();
    this.lastBlock = null;
    this.line();
  }

  /** Línea de actividad (herramienta, permiso, plan): separada de la respuesta. */
  activity(s: string) {
    this.newline();
    if (this.lastBlock === "message") this.write("\n");
    this.lastBlock = "activity";
    this.write(s + "\n");
  }

  endTurn(stopReason: string) {
    this.newline();
    this.write("\n");
    this.lastBlock = null;
    const secs = ((Date.now() - this.turnStart) / 1000).toFixed(1);
    const parts = [`${secs} s`];
    if (this.toolCount) parts.push(`${this.toolCount} herramienta${this.toolCount === 1 ? "" : "s"}`);
    if (stopReason !== "end_turn") parts.push(stopReasonLabel(stopReason));
    this.line(st.gray(`  ── ${parts.join(" · ")}`));
  }

  update(n: SessionNotification) {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type !== "text") break;
        if (this.stream !== "message") {
          this.newline();
          if (this.lastBlock === "activity") this.write("\n");
          this.stream = "message";
          this.lastBlock = "message";
        }
        this.md.push(u.content.text);
        break;

      case "agent_thought_chunk":
        if (!this.showThoughts || u.content.type !== "text") break;
        if (this.stream !== "thought") {
          this.newline();
          this.stream = "thought";
          this.write(st.gray("  ✻ "));
        }
        this.write(st.dim(st.italic(u.content.text.replace(/\n/g, "\n    "))));
        break;

      case "tool_call": {
        const raw = u.title || u.kind || "herramienta";
        const m = BRIDGE_TOOL.exec(raw);
        const name = m ? m[1] : raw;
        const bridged = Boolean(m);
        const hidden = HIDDEN_TOOLS.has(raw);
        this.tools.set(u.toolCallId, { name, bridged, shown: !bridged && !hidden });
        if (!hidden) this.toolCount++;
        // Las del puente se muestran cuando se ejecutan en esta máquina (línea ⌂).
        if (!bridged && !hidden) this.activity(`  ${st.accent("◇")} ${st.bold(name)}${u.kind && u.kind !== "other" ? st.gray(` ${u.kind}`) : ""}`);
        break;
      }

      case "tool_call_update": {
        const t = this.tools.get(u.toolCallId);
        if (u.status === "failed") {
          const name = t?.name ?? u.title ?? "herramienta";
          const reason = firstLine(u.content);
          this.activity(`  ${st.red("✗")} ${st.bold(name)}${reason ? st.gray(`  ${truncate(reason, termWidth() - name.length - 8)}`) : ""}`);
        }
        break;
      }

      case "plan": {
        this.activity(`  ${st.bold("Plan")}`);
        for (const e of u.entries) {
          const mark =
            e.status === "completed" ? st.green("✓") : e.status === "in_progress" ? st.accent("▸") : st.gray("○");
          const text = e.status === "completed" ? st.gray(e.content) : e.content;
          this.line(`    ${mark} ${text}`);
        }
        break;
      }

      case "available_commands_update":
        this.availableCommands = u.availableCommands;
        break;

      case "current_mode_update":
        this.currentMode = u.currentModeId;
        this.line(st.gray(`  modo → ${u.currentModeId}`));
        break;

      case "config_option_update":
        this.configOptions = u.configOptions;
        break;

      default:
        break;
    }
  }

  /** Actividad ejecutada en el disco o la terminal de esta máquina. */
  local(kind: LocalKind, detail: string) {
    const label = LOCAL_LABEL[kind].padEnd(7);
    const d = kind === "exec" ? `${st.gray("$")} ${detail}` : detail;
    this.activity(`  ${st.blue("⌂")} ${st.gray(label)} ${truncate(d, termWidth() - 14)}`);
  }

  /** Valor legible de una opción de sesión (modelo, esfuerzo…). */
  configValue(id: string): string | undefined {
    const opt = this.configOptions.find((o) => o.id === id || ("category" in o && o.category === id));
    if (!opt || opt.type !== "select") return undefined;
    const flat = (opt.options as Array<{ value?: string; name?: string; options?: Array<{ value: string; name: string }> }>).flatMap(
      (o) => o.options ?? [o],
    );
    return flat.find((o) => o.value === opt.currentValue)?.name ?? String(opt.currentValue);
  }
}

function firstLine(content?: ToolCallContent[] | null): string | undefined {
  for (const c of content ?? []) {
    if (c.type === "content" && c.content.type === "text") {
      const l = c.content.text.split("\n").find((x) => x.trim());
      if (l) return l.replace(/^Error:\s*/, "").replace(/<\/?tool_use_error>/g, "").trim();
    }
  }
  return undefined;
}

function stopReasonLabel(r: string): string {
  switch (r) {
    case "cancelled":
      return "cancelado";
    case "max_tokens":
      return "límite de tokens";
    case "max_turn_requests":
      return "límite de pasos";
    case "refusal":
      return "rechazado por el modelo";
    default:
      return r;
  }
}

export { tildify };
