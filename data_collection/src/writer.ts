/**
 * @file writer.ts
 * @description Serialises and writes a GerritDataOutput object to a JSON file.
 *
 * Uses 2-space indentation so the output is human-readable, and writes
 * atomically (write to a temp file then rename) to avoid producing a
 * truncated JSON file if the process is interrupted.
 */

import * as fs from "fs";
import * as path from "path";
import type { GerritDataOutput, ChangeMetadata } from "./types";

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Streams enriched changes incrementally to a JSON file.
 *
 * The write is atomic: data is first written to a temporary file in the same
 * directory, then renamed to the final path upon successful completion. This
 * guarantees that the output file is never observed in a partially-written state.
 */
export class StreamingJsonWriter {
  private stream: fs.WriteStream;
  private isFirst = true;
  private resolvedPath: string;
  private tmpPath: string;

  constructor(
    outputPath: string,
    private headerData: Omit<GerritDataOutput, "changes">,
    resume: boolean = false,
  ) {
    this.resolvedPath = path.resolve(outputPath);
    const dir = path.dirname(this.resolvedPath);
    const basename = path.basename(this.resolvedPath);

    // Ensure the destination directory exists.
    fs.mkdirSync(dir, { recursive: true });

    // Stream to a temp file first. Remove PID to allow resuming.
    this.tmpPath = path.join(dir, `${basename}.tmp`);

    if (resume && fs.existsSync(this.tmpPath)) {
      this.stream = fs.createWriteStream(this.tmpPath, {
        flags: "a",
        encoding: "utf8",
      });
      this.isFirst = false;
    } else {
      this.stream = fs.createWriteStream(this.tmpPath, {
        flags: "w",
        encoding: "utf8",
      });

      // Write header
      this.stream.write(
        `{\n  "collected_at": ${JSON.stringify(this.headerData.collected_at)},\n`,
      );
      this.stream.write(
        `  "source_url": ${JSON.stringify(this.headerData.source_url)},\n`,
      );
      this.stream.write(
        `  "total_changes": ${JSON.stringify(this.headerData.total_changes)},\n`,
      );
      this.stream.write(`  "changes": [\n`);
    }
  }

  /**
   * Appends a single change object to the JSON array.
   */
  public writeChange(change: ChangeMetadata): void {
    const prefix = this.isFirst ? "" : ",\n";
    this.isFirst = false;

    // Indent the change JSON string so it looks nice in the file.
    const jsonStr = JSON.stringify(change, null, 2);
    const indented = jsonStr
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");

    this.stream.write(`${prefix}${indented}`);
  }

  /**
   * Closes the JSON array and root object, then atomically renames the temp
   * file to the target destination.
   */
  public end(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(`\n  ]\n}\n`);

      // The .end() callback takes no arguments in Node.js streams.
      this.stream.end(() => {
        try {
          fs.renameSync(this.tmpPath, this.resolvedPath);
          console.log(`[writer] Output written to: ${this.resolvedPath}`);
          resolve();
        } catch (renameErr) {
          this.cleanup();
          reject(renameErr);
        }
      });

      // If a stream error occurs during finalization, catch it here.
      this.stream.on("error", (err) => {
        this.cleanup();
        reject(err);
      });
    });
  }

  /**
   * Cleans up the temporary file if something goes wrong.
   */
  public cleanup(): void {
    try {
      if (fs.existsSync(this.tmpPath)) {
        fs.unlinkSync(this.tmpPath);
      }
    } catch {
      // Ignore cleanup errors.
    }
  }
}
