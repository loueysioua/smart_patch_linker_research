/**
 * @file checkpoint.ts
 * @description Checkpoint manager for the Gerrit collection pipeline.
 *
 * Since each change is written inside a `<_number>` directory with separate
 * JSON files for each category (`metadata.json`, `patchsets.json`, `diffs.json`,
 * `comments.json`), resume logic is: scan the output directory for change
 * subdirectories, and check if the file for the active mode exists and is valid.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Validation ───────────────────────────────────────────────────────────────

function isChangeMetadataValid(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const c = obj as Record<string, unknown>;

  if (typeof c["id"] !== "string" || c["id"] === "") return false;
  if (typeof c["change_id"] !== "string" || c["change_id"] === "") return false;
  if (typeof c["_number"] !== "number") return false;
  if (typeof c["status"] !== "string" || c["status"] === "") return false;

  const ts = c["timestamps"];
  if (typeof ts !== "object" || ts === null) return false;
  const timestamps = ts as Record<string, unknown>;
  if (typeof timestamps["created"] !== "string" || timestamps["created"] === "")
    return false;

  const accounts = c["accounts"];
  if (typeof accounts !== "object" || accounts === null) return false;
  const accs = accounts as Record<string, unknown>;
  if (typeof accs["owner"] !== "object" || accs["owner"] === null) return false;

  if (typeof c["subject"] !== "string" || c["subject"] === "") return false;

  const cl = c["change_log"];
  if (typeof cl !== "object" || cl === null) return false;
  const clObj = cl as Record<string, unknown>;
  if (!Array.isArray(clObj["entries"])) return false;

  return true;
}

function isPatchsetsValid(obj: unknown): boolean {
  if (!Array.isArray(obj)) return false;
  if (obj.length === 0) return false;
  for (const ps of obj) {
    if (typeof ps !== "object" || ps === null) return false;
    const psObj = ps as Record<string, unknown>;
    if (typeof psObj["patchset_number"] !== "number") return false;
    if (typeof psObj["commit_sha"] !== "string" || psObj["commit_sha"] === "") return false;
    if (!Array.isArray(psObj["modified_file_paths"])) return false;
  }
  return true;
}

function isDiffsValid(obj: unknown): boolean {
  if (!Array.isArray(obj)) return false;
  for (const ps of obj) {
    if (typeof ps !== "object" || ps === null) return false;
    const psObj = ps as Record<string, unknown>;
    if (typeof psObj["patchset_number"] !== "number") return false;
    if (typeof psObj["commit_sha"] !== "string" || psObj["commit_sha"] === "") return false;
    if (!Array.isArray(psObj["file_diffs"])) return false;
  }
  return true;
}

function isCommentsValid(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const c = obj as Record<string, unknown>;
  if (typeof c["id"] !== "string" || c["id"] === "") return false;
  if (typeof c["change_id"] !== "string" || c["change_id"] === "") return false;
  if (typeof c["_number"] !== "number") return false;
  if (!Array.isArray(c["change_comments"])) return false;
  if (!Array.isArray(c["inline_comments"])) return false;
  return true;
}

// ─── CheckpointResult ─────────────────────────────────────────────────────────

export interface CheckpointResult {
  /** _number IDs of changes that are already written and structurally valid for the current mode. */
  cleanIds: Set<number>;
  /** _number IDs of changes whose file existed but failed validation (deleted, will be re-fetched). */
  corruptIds: Set<number>;
}

// ─── CheckpointManager ────────────────────────────────────────────────────────

export class CheckpointManager {
  private readonly outputDir: string;
  private readonly mode: string;

  /**
   * @param outputDir  Path to the directory where per-change directories live.
   * @param mode       The active extraction mode (metadata | patchsets | diffs | comments).
   */
  constructor(outputDir: string, mode: string) {
    this.outputDir = path.resolve(outputDir);
    this.mode = mode;
  }

  /**
   * Scans the output directory for existing change subdirectories.
   *
   * For each change directory, it:
   *  - Checks if `<mode>.json` exists.
   *  - If it exists, parses and validates it based on the mode.
   *  - If valid  → its `_number` is added to `cleanIds` (skip on resume).
   *  - If invalid → the file is deleted and the `_number` is added to
   *    `corruptIds` (will be re-fetched).
   */
  analyse(): CheckpointResult {
    const cleanIds = new Set<number>();
    const corruptIds = new Set<number>();

    if (!fs.existsSync(this.outputDir)) {
      console.log(`[checkpoint] Output directory does not exist yet — starting fresh.`);
      return { cleanIds, corruptIds };
    }

    const entries = fs.readdirSync(this.outputDir);
    const changeDirs = entries.filter(
      (f) => /^\d+$/.test(f) && fs.statSync(path.join(this.outputDir, f)).isDirectory()
    );

    console.log(
      `[checkpoint] Found ${changeDirs.length} change directory(s) in ${this.outputDir}`
    );

    let corrupt = 0;
    for (const dir of changeDirs) {
      const num = parseInt(dir, 10);
      const filePath = path.join(this.outputDir, dir, `${this.mode}.json`);

      if (!fs.existsSync(filePath)) {
        // Mode file does not exist, so it needs to be fetched
        continue;
      }

      let parsed: unknown;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`[checkpoint] Could not parse ${dir}/${this.mode}.json — deleting and re-fetching.`);
        fs.unlinkSync(filePath);
        corruptIds.add(num);
        corrupt++;
        continue;
      }

      let isValid = false;
      if (this.mode === "metadata") {
        isValid = isChangeMetadataValid(parsed);
      } else if (this.mode === "patchsets") {
        isValid = isPatchsetsValid(parsed);
      } else if (this.mode === "diffs") {
        isValid = isDiffsValid(parsed);
      } else if (this.mode === "comments") {
        isValid = isCommentsValid(parsed);
      }

      if (isValid) {
        cleanIds.add(num);
      } else {
        console.warn(
          `[checkpoint] ${dir}/${this.mode}.json failed integrity check — deleting and re-fetching.`
        );
        fs.unlinkSync(filePath);
        corruptIds.add(num);
        corrupt++;
      }
    }

    console.log(
      `[checkpoint] [${this.mode}] Clean: ${cleanIds.size} | Corrupt/deleted: ${corrupt}`
    );

    return { cleanIds, corruptIds };
  }
}

