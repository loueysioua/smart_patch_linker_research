/**
 * @file writer.ts
 * @description Writes each enriched change's category data as an individual JSON file inside a directory per change.
 *
 * Output layout:
 *   <outputDir>/
 *     <change_number>/
 *       metadata.json
 *       patchsets.json
 *       diffs.json
 *       comments.json
 *
 * Atomic write strategy:
 *   1. Write to `<filename>.json.tmp`
 *   2. Rename to `<filename>.json`
 * This ensures no partially-written file is ever mistaken for a valid one by
 * the checkpoint scanner on the next resume.
 */

import * as fs from "fs";
import * as path from "path";

// ─── ChangeWriter ─────────────────────────────────────────────────────────────

export class ChangeWriter {
  private readonly outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = path.resolve(outputDir);
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Atomically writes mode-specific data to `<outputDir>/<changeIdNumber>/<filename>.json`.
   */
  write(changeIdNumber: number, filename: string, data: unknown): void {
    const changeDir = path.join(this.outputDir, String(changeIdNumber));
    fs.mkdirSync(changeDir, { recursive: true });

    const finalPath = path.join(changeDir, `${filename}.json`);
    const tmpPath = finalPath + ".tmp";

    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, finalPath);
  }
}

