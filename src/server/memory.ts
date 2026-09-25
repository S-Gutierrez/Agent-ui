import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_MEMORY_BYTES = 256 * 1024;

/** Turns an agent name/id into a safe file stem: no separators, no dots, no traversal. */
export function memorySlug(s: string): string {
  const slug = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "agent";
}

/**
 * Each agent's personal memory is a Markdown file: `<dir>/<slug(name)>.md`.
 * The agents themselves are expected to maintain it (see README); the office
 * lets you read and edit it.
 */
export class MemoryStore {
  constructor(readonly dir: string) {}

  fileFor(name: string): string {
    const file = path.resolve(this.dir, `${memorySlug(name)}.md`);
    // Defence in depth: the slug cannot escape, but never trust it blindly.
    if (path.dirname(file) !== path.resolve(this.dir)) throw new Error("invalid memory path");
    return file;
  }

  async read(name: string): Promise<{ file: string; content: string; exists: boolean }> {
    const file = this.fileFor(name);
    try {
      return { file, content: await readFile(file, "utf8"), exists: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file, content: "", exists: false };
      throw err;
    }
  }

  async write(name: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("memory file too large");
    const file = this.fileFor(name);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  }
}
