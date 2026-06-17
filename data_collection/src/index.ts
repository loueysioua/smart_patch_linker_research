/**
 * @file index.ts
 * @description Entry point for the Gerrit data-collection script.
 *
 * Pipeline per change:
 *   1. Query /changes/ with ALL_REVISIONS + DETAILED_ACCOUNTS + MESSAGES
 *   2. For each patchset revision:
 *        a. GET /revisions/{sha}/files      → file list
 *        b. GET /revisions/{sha}/files/{f}/diff → unified diff per file
 *   3. GET /revisions/current/commit        → full commit message
 *   4. GET /comments                        → inline comments
 *   5. Map raw data → ChangeMetadata → write JSON
 *
 * Usage:
 *   npx ts-node src/index.ts [options]
 *
 * Options:
 *   --query   <string>   Gerrit search expression (default: "is:open")
 *   --limit   <number>   Maximum number of changes to retrieve
 *   --output  <path>     Destination JSON file (default: ./output/gerrit_changes.json)
 *   --concurrency <n>    Max parallel per-change enrichment requests (default: 3)
 *
 * Example:
 *   npx ts-node src/index.ts --query "is:merged" --limit 50 --output ./data/merged.json
 */

import { GerritClient } from "./gerrit-client";
import { mapChangeToMetadata } from "./mapper";
import { StreamingJsonWriter } from "./writer";
import * as fs from "fs";
import * as path from "path";
import type { GerritDataOutput, ChangeMetadata } from "./types";
import type {
  RawCommentsResponse,
  RawCommitInfo,
  RawDiffInfo,
  RawFilesResponse,
} from "./gerrit-client";
import type { ChangeInfo } from "@gerritcodereview/typescript-api/rest-api";

// ─── Configuration ────────────────────────────────────────────────────────────

const GERRIT_BASE_URL = "https://gerrit.onap.org/r" as const;
const DEFAULT_OUTPUT = "./output/gerrit_changes.json" as const;
const DEFAULT_QUERY = "is:open" as const;
const DEFAULT_CONCURRENCY = 6;

// ─── CLI argument parsing ─────────────────────────────────────────────────────

interface CliArgs {
  query: string;
  limit?: number;
  output: string;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let query: string = DEFAULT_QUERY;
  let limit: number | undefined;
  let output: string = DEFAULT_OUTPUT;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--query":
        query = args[++i] ?? DEFAULT_QUERY;
        break;
      case "--limit": {
        const raw = parseInt(args[++i] ?? "", 10);
        if (!Number.isFinite(raw) || raw <= 0)
          throw new Error(
            `--limit must be a positive integer, got: ${args[i]}`,
          );
        limit = raw;
        break;
      }
      case "--output":
        output = args[++i] ?? DEFAULT_OUTPUT;
        break;
      case "--concurrency": {
        const raw = parseInt(args[++i] ?? "", 10);
        if (!Number.isFinite(raw) || raw <= 0)
          throw new Error(
            `--concurrency must be a positive integer, got: ${args[i]}`,
          );
        concurrency = raw;
        break;
      }
      default:
        console.warn(`[index] Unknown argument: ${args[i]}`);
    }
  }

  return { query, limit, output, concurrency };
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

/**
 * Executes a list of Promise-returning functions with a maximum concurrency limit.
 * Instead of accumulating all results in memory, it invokes a callback for each
 * completed batch to allow streaming.
 */
async function runWithConcurrencyStreaming<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onBatchDone: (results: T[]) => void,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map((t) => t());
    const resolvedBatch = await Promise.all(batch);
    onBatchDone(resolvedBatch);
  }
}

// ─── Per-change enrichment ────────────────────────────────────────────────────

/**
 * Fetches all supplementary data required to fully populate a ChangeMetadata
 * record for a single change.
 */
async function enrichChange(
  client: GerritClient,
  change: ChangeInfo,
): Promise<ChangeMetadata> {
  const changeId = Number(change._number);
  const revisions = change.revisions ?? {};
  const revShas = Object.keys(revisions);

  // ── 1. Commit message (current patchset) ───────────────────────────────────
  let commitInfo: RawCommitInfo = {};
  try {
    commitInfo = await client.fetchCommitInfo(changeId, "current");
  } catch (err) {
    console.warn(`  [enrich] commit fetch failed for #${changeId}:`, err);
  }

  // ── 2. File lists + diffs per patchset ────────────────────────────────────
  const filesPerRevision = new Map<string, RawFilesResponse>();
  const diffsPerRevision = new Map<string, Map<string, RawDiffInfo>>();

  for (const sha of revShas) {
    // File list for this patchset
    let rawFiles: RawFilesResponse = {};
    try {
      rawFiles = await client.fetchFiles(changeId, sha);
    } catch (err) {
      console.warn(
        `  [enrich] files fetch failed for #${changeId}@${sha.slice(0, 7)}:`,
        err,
      );
    }
    filesPerRevision.set(sha, rawFiles);

    // Diff per file (skip /COMMIT_MSG virtual file)
    const diffMap = new Map<string, RawDiffInfo>();

    for (const [filePath, fileInfo] of Object.entries(rawFiles)) {
      if (filePath === "/COMMIT_MSG") continue;
      try {
        const diff = await client.fetchFileDiff(changeId, sha, filePath);
        diffMap.set(filePath, diff);
      } catch (err) {
        console.warn(
          `  [enrich] diff fetch failed for #${changeId}@${sha.slice(0, 7)} ${filePath}:`,
          (err as Error).message,
        );
      }
    }

    diffsPerRevision.set(sha, diffMap);
  }

  // ── 3. Inline comments ────────────────────────────────────────────────────
  let rawComments: RawCommentsResponse = {};
  try {
    rawComments = await client.fetchComments(changeId);
  } catch (err) {
    console.warn(`  [enrich] comments fetch failed for #${changeId}:`, err);
  }

  // ── 4. Map everything ─────────────────────────────────────────────────────
  return mapChangeToMetadata(
    change,
    commitInfo,
    filesPerRevision,
    diffsPerRevision,
    rawComments,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { query, limit, output, concurrency } = parseArgs(process.argv);

  console.log("═".repeat(60));
  console.log("  Gerrit Data Collection (extended)");
  console.log("═".repeat(60));
  console.log(`  Source      : ${GERRIT_BASE_URL}`);
  console.log(`  Query       : ${query}`);
  console.log(`  Limit       : ${limit ?? "none (all results)"}`);
  console.log(`  Concurrency : ${concurrency}`);
  console.log(`  Output      : ${output}`);
  console.log("─".repeat(60));

  const client = new GerritClient(GERRIT_BASE_URL);

  const tmpFile = path.join(
    path.dirname(path.resolve(output)),
    path.basename(output) + ".tmp",
  );

  if (!fs.existsSync(tmpFile)) {
    const dir = path.dirname(path.resolve(output));
    const basename = path.basename(output);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      const pidTmpFiles = files.filter(
        (f) =>
          f.startsWith(basename + ".") &&
          f.endsWith(".tmp") &&
          f !== basename + ".tmp",
      );
      if (pidTmpFiles.length > 0) {
        const latestPidTmp = pidTmpFiles.sort(
          (a, b) =>
            fs.statSync(path.join(dir, b)).mtimeMs -
            fs.statSync(path.join(dir, a)).mtimeMs,
        )[0];
        fs.renameSync(path.join(dir, latestPidTmp), tmpFile);
        console.log(
          `[index] Renamed old temp file ${latestPidTmp} to ${path.basename(tmpFile)}`,
        );
      }
    }
  }

  let isResume = false;
  let lastProcessedId: number | null = null;

  if (fs.existsSync(tmpFile)) {
    console.log(`[index] Found previous tmp file, preparing to resume...`);
    const content = fs.readFileSync(tmpFile, "utf8");
    const regex = /"_number":\s*(\d+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      lastProcessedId = Number(match[1]);
    }
    if (lastProcessedId !== null) {
      isResume = true;
    }
  }

  // 1. Fetch all matching changes (already includes revisions + messages).
  const allRawChanges = await client.fetchAllChanges(query, limit);
  let rawChanges = allRawChanges;

  if (isResume && lastProcessedId !== null) {
    const lastIndex = allRawChanges.findIndex(
      (c) => Number(c._number) === lastProcessedId,
    );
    if (lastIndex !== -1) {
      rawChanges = allRawChanges.slice(lastIndex + 1);
      console.log(
        `[index] Resuming... Skipping ${lastIndex + 1} already processed changes (last ID: ${lastProcessedId}).`,
      );
    }
  }

  console.log(`\n[index] Changes fetched: ${allRawChanges.length}`);
  if (isResume) {
    console.log(`[index] Changes left to enrich: ${rawChanges.length}`);
  }

  // 2. Initialise the streaming writer
  const headerData: Omit<GerritDataOutput, "changes"> = {
    collected_at: new Date().toISOString(),
    source_url: GERRIT_BASE_URL,
    total_changes: allRawChanges.length,
  };

  const writer = new StreamingJsonWriter(output, headerData, isResume);

  // 3. Enrich each change (commit, files, diffs, comments) concurrently,
  //    appending them to the file as batches complete.
  console.log(`\n[index] Enriching changes (concurrency=${concurrency})…`);

  const tasks = rawChanges.map((change, idx) => async () => {
    console.log(
      `[index] Enriching [${idx + 1}/${rawChanges.length}] ` +
        `#${change._number} – ${change.subject.slice(0, 60)}`,
    );
    return enrichChange(client, change);
  });

  try {
    await runWithConcurrencyStreaming(tasks, concurrency, (batchResults) => {
      for (const changeMetadata of batchResults) {
        writer.writeChange(changeMetadata);
      }
    });

    // 4. Finalise output file
    await writer.end();
  } catch (err) {
    writer.cleanup();
    throw err;
  }

  console.log("\n[index] Done ✓");
  console.log("═".repeat(60));
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
