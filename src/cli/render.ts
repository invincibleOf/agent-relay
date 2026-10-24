import type { AvailableCommand, SessionNotification } from "@agentclientprotocol/sdk";

const isTTY = process.stdout.isTTY;
const c = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  dim: c("2"),
  bold: c("1"),
  red: c("31"),
  green: c("32"),
  yellow: c("33"),
  blue: c("34"),
  magenta: c("35"),
  cyan: c("36"),
};

/** Dibuja en la terminal las actualizaciones de sesión que envía el agente. */
export class Renderer {
  availableCommands: AvailableCommand[] = [];
  currentMode?: string;
  private midLine = false;
  private lastStream: "message" | "thought" | null = null;
  private toolTitles = new Map<string, string>();

  constructor(private showThoughts: boolean) {}

  private write(s: string) {
    process.stdout.write(s);
    this.midLine = !s.endsWith("\n");
  }

  /** Asegura que lo siguiente empiece en una línea nueva. */
  newline() {
    if (this.midLine) this.write("\n");
    this.lastStream = null;
  }

  line(s: string) {
    this.newline();
    this.write(s + "\n");
  }

  update(n: SessionNotification) {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          if (this.lastStream !== "message") this.newline();
          this.lastStream = "message";
          this.write(u.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (this.showThoughts && u.content.type === "text") {
          if (this.lastStream !== "thought") this.newline();
          this.lastStream = "thought";
          this.write(color.dim(u.content.text));
        }
        break;
      case "tool_call": {
        const title = u.title || u.kind || "herramienta";
        this.toolTitles.set(u.toolCallId, title);
        this.line(color.cyan(`⚙ ${title}`) + (u.kind ? color.dim(` [${u.kind}]`) : ""));
        break;
      }
      case "tool_call_update": {
        if (u.title) this.toolTitles.set(u.toolCallId, u.title);
        const title = this.toolTitles.get(u.toolCallId) ?? u.toolCallId;
        if (u.status === "completed") this.line(color.green(`  ✓ ${title}`));
        else if (u.status === "failed") this.line(color.red(`  ✗ ${title}`));
        break;
      }
      case "plan":
        this.line(color.magenta("Plan:"));
        for (const e of u.entries) {
          const mark = e.status === "completed" ? "☑" : e.status === "in_progress" ? "▸" : "☐";
          this.line(color.magenta(`  ${mark} ${e.content}`));
        }
        break;
      case "available_commands_update":
        this.availableCommands = u.availableCommands;
        break;
      case "current_mode_update":
        this.currentMode = u.currentModeId;
        this.line(color.dim(`(modo: ${u.currentModeId})`));
        break;
      default:
        break;
    }
  }

  /** Actividad que ocurrió en el disco o la terminal de esta máquina. */
  local(kind: "read" | "write" | "exec", detail: string) {
    const label = kind === "read" ? "lee" : kind === "write" ? "escribe" : "ejecuta";
    this.line(color.blue(`  ⌂ local ${label}: ${detail}`));
  }
}
