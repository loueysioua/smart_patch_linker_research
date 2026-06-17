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
 *   5. Map raw data → ChangeMetadata → write as <_number>.json in output dir
 *
 * Interruption recovery:
 *   On restart the CheckpointManager scans the output directory for existing
 *   `<_number>.json` files, validates each one, and builds two sets:
 *     - cleanIds   → skip (already correctly written)
 *     - corruptIds → re-fetch (file exists but failed integrity validation;
 *                              the bad file is deleted automatically)
 *   No tmp file or streaming state needed — each file is written atomically.
 *
 * Concurrency model:
 *   A true sliding-window pool keeps exactly `concurrency` enrichment tasks
 *   running at all times (not batch-at-a-time), and the GerritClient's built-in
 *   RateLimiter serialises the actual HTTP calls within each task so we never
 *   exceed Gerrit's quota.
 *
 * Usage:
 *   npx ts-node src/index.ts [options]
 *
 * Options:
 *   --query          <string>   Gerrit search expression (default: "is:open")
 *   --limit          <number>   Maximum number of changes to retrieve
 *   --output         <path>     Output directory for per-change JSON files
 *                               (default: ./output/changes)
 *   --concurrency    <n>        Max parallel per-change enrichment tasks (default: 6)
 *   --rate-max       <n>        Max HTTP requests per rate window (default: 30)
 *   --rate-window    <ms>       Rate-limiter rolling window in ms (default: 10000)
 *   --rate-interval  <ms>       Min gap between consecutive requests in ms (default: 200)
 *   --timeout        <ms>       Per-request HTTP timeout in ms (default: 30000)
 *
 * Example:
 *   npx ts-node src/index.ts --query "is:merged" --limit 50 \
 *     --rate-max 20 --rate-window 10000 --rate-interval 300
 */

import { GerritClient } from "./gerrit-client";
import {
  mapChangeToMetadata,
  mapChangePatchsets,
  mapChangeDiffs,
  mapChangeComments,
} from "./mapper";
import { ChangeWriter } from "./writer";
import { CheckpointManager } from "./checkpoint";
import type {
  ChangeMetadata,
  PatchsetInfo,
  PatchsetDiff,
  ChangeComments,
} from "./types";
import type {
  RawCommentsResponse,
  RawCommitInfo,
  RawDiffInfo,
  RawFilesResponse,
} from "./gerrit-client";
import type { ChangeInfo } from "@gerritcodereview/typescript-api/rest-api";

// ─── Configuration ────────────────────────────────────────────────────────────

const GERRIT_BASE_URL = "https://gerrit.libreoffice.org/" as const;
const DEFAULT_OUTPUT = "./output/changes" as const;
const DEFAULT_QUERY = "is:open" as const;
const DEFAULT_CONCURRENCY = 6;

// ─── CLI argument parsing ─────────────────────────────────────────────────────

interface CliArgs {
  query: string;
  limit?: number;
  output: string;
  concurrency: number;
  rateMax: number;
  rateWindowMs: number;
  rateIntervalMs: number;
  timeoutMs: number;
  mode: "metadata" | "patchsets" | "diffs" | "comments" | "all";
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  let query: string = DEFAULT_QUERY;
  let limit: number | undefined;
  let output: string = DEFAULT_OUTPUT;
  let concurrency = DEFAULT_CONCURRENCY;
  let rateMax = 30;
  let rateWindowMs = 10_000;
  let rateIntervalMs = 200;
  let timeoutMs = 30_000;
  let mode: CliArgs["mode"] = "all";

  const requireInt = (value: string | undefined, flag: string): number => {
    const n = parseInt(value ?? "", 10);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${flag} must be a positive integer, got: ${value}`);
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--query":
        query = args[++i] ?? DEFAULT_QUERY;
        break;
      case "--limit":
        limit = requireInt(args[++i], "--limit");
        break;
      case "--output":
        output = args[++i] ?? DEFAULT_OUTPUT;
        break;
      case "--concurrency":
        concurrency = requireInt(args[++i], "--concurrency");
        break;
      case "--rate-max":
        rateMax = requireInt(args[++i], "--rate-max");
        break;
      case "--rate-window":
        rateWindowMs = requireInt(args[++i], "--rate-window");
        break;
      case "--rate-interval":
        rateIntervalMs = requireInt(args[++i], "--rate-interval");
        break;
      case "--timeout":
        timeoutMs = requireInt(args[++i], "--timeout");
        break;
      case "--mode":
        const m = args[++i];
        if (
          m !== "metadata" &&
          m !== "patchsets" &&
          m !== "diffs" &&
          m !== "comments" &&
          m !== "all"
        ) {
          throw new Error(
            `--mode must be one of: metadata, patchsets, diffs, comments, all. Got: ${m}`,
          );
        }
        mode = m;
        break;
      default:
        console.warn(`[index] Unknown argument: ${args[i]}`);
    }
  }

  return {
    query,
    limit,
    output,
    concurrency,
    rateMax,
    rateWindowMs,
    rateIntervalMs,
    timeoutMs,
    mode,
  };
}

// ─── Sliding-window concurrency pool ─────────────────────────────────────────

/**
 * Runs `tasks` with at most `concurrency` running at any instant (true sliding
 * window — a new task starts as soon as any running one finishes).
 *
 * Unlike the previous batch-at-a-time approach, this keeps all concurrency
 * slots occupied for the entire duration of the run instead of waiting for
 * the slowest task in each batch before launching the next group.
 *
 * `onComplete` is called with each result in completion order (not submission
 * order) so the writer can stream results immediately.
 */
async function runWithSlidingWindow<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onComplete: (result: T) => void,
): Promise<void> {
  let nextIndex = 0;
  let inFlight = 0;

  return new Promise((resolve, reject) => {
    const tryLaunch = (): void => {
      // Launch as many tasks as available slots allow.
      while (inFlight < concurrency && nextIndex < tasks.length) {
        const taskFn = tasks[nextIndex++];
        inFlight++;

        taskFn()
          .then((result) => {
            inFlight--;
            onComplete(result);
            if (nextIndex < tasks.length) {
              tryLaunch();
            } else if (inFlight === 0) {
              resolve();
            }
          })
          .catch((err) => {
            reject(err);
          });
      }

      // All tasks submitted and nothing running → done.
      if (inFlight === 0 && nextIndex >= tasks.length) {
        resolve();
      }
    };

    tryLaunch();
  });
}

// ─── Per-change enrichment ────────────────────────────────────────────────────

async function enrichMetadata(
  client: GerritClient,
  change: ChangeInfo,
): Promise<ChangeMetadata> {
  const changeId = Number(change._number);
  let commitInfo: RawCommitInfo = {};
  try {
    commitInfo = await client.fetchCommitInfo(changeId, "current");
  } catch (err) {
    console.warn(`  [enrich] commit fetch failed for #${changeId}:`, err);
  }
  return mapChangeToMetadata(change, commitInfo);
}

async function enrichPatchsets(
  client: GerritClient,
  change: ChangeInfo,
): Promise<PatchsetInfo[]> {
  const changeId = Number(change._number);
  const revisions = change.revisions ?? {};
  const revShas = Object.keys(revisions);
  const filesPerRevision = new Map<string, RawFilesResponse>();

  for (const sha of revShas) {
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
  }

  return mapChangePatchsets(change, filesPerRevision);
}

async function enrichDiffs(
  client: GerritClient,
  change: ChangeInfo,
): Promise<PatchsetDiff[]> {
  const changeId = Number(change._number);
  const revisions = change.revisions ?? {};
  const revShas = Object.keys(revisions);
  const filesPerRevision = new Map<string, RawFilesResponse>();
  const diffsPerRevision = new Map<string, Map<string, RawDiffInfo>>();

  for (const sha of revShas) {
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

    const diffMap = new Map<string, RawDiffInfo>();
    for (const filePath of Object.keys(rawFiles)) {
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

  return mapChangeDiffs(change, diffsPerRevision, filesPerRevision);
}

async function enrichComments(
  client: GerritClient,
  change: ChangeInfo,
): Promise<ChangeComments> {
  const changeId = Number(change._number);
  let rawComments: RawCommentsResponse = {};
  try {
    rawComments = await client.fetchComments(changeId);
  } catch (err) {
    console.warn(`  [enrich] comments fetch failed for #${changeId}:`, err);
  }
  return mapChangeComments(change, rawComments);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    query,
    limit,
    output,
    concurrency,
    rateMax,
    rateWindowMs,
    rateIntervalMs,
    timeoutMs,
    mode,
  } = parseArgs(process.argv);

  console.log("═".repeat(60));
  console.log("  Gerrit Data Collection");
  console.log("═".repeat(60));
  console.log(`  Source          : ${GERRIT_BASE_URL}`);
  console.log(`  Query           : ${query}`);
  console.log(`  Limit           : ${limit ?? "none (all results)"}`);
  console.log(`  Concurrency     : ${concurrency}`);
  console.log(`  Rate limit      : ${rateMax} req / ${rateWindowMs}ms`);
  console.log(`  Min interval    : ${rateIntervalMs}ms`);
  console.log(`  Request timeout : ${timeoutMs}ms`);
  console.log(`  Output dir      : ${output}`);
  console.log(`  Mode            : ${mode}`);
  console.log("═".repeat(60));

  const client = new GerritClient(GERRIT_BASE_URL, {
    rateLimiter: {
      maxRequests: rateMax,
      windowMs: rateWindowMs,
      minIntervalMs: rateIntervalMs,
      requestTimeoutMs: timeoutMs,
    },
  });

  // Fetch the full change list once for the entire run
  console.log(`[index] Fetching change list from Gerrit…`);
  const allRawChanges = await client.fetchAllChanges(query, limit);
  console.log(
    `[index] Found ${allRawChanges.length} change(s) matching query.`,
  );

  const modesToRun: ("metadata" | "patchsets" | "diffs" | "comments")[] =
    mode === "all" ? ["metadata", "patchsets", "diffs", "comments"] : [mode];

  const writer = new ChangeWriter(output);

  for (const activeMode of modesToRun) {
    console.log("\n" + "─".repeat(60));
    console.log(`  Processing Mode: ${activeMode.toUpperCase()}`);
    console.log("─".repeat(60));

    // ── Checkpoint: scan output directory for active mode ───────────────────
    const checkpoint = new CheckpointManager(output, activeMode);
    const { cleanIds, corruptIds } = checkpoint.analyse();

    // Decide which changes need enrichment for this mode
    const changesToEnrich = allRawChanges.filter(
      (c) => !cleanIds.has(Number(c._number)),
    );

    console.log(
      `[index] [${activeMode}] Already written (skip): ${cleanIds.size}`,
    );
    console.log(
      `[index] [${activeMode}] To enrich             : ${changesToEnrich.length}`,
    );
    if (corruptIds.size > 0) {
      console.log(
        `[index] [${activeMode}] Re-fetching corrupt   : ${corruptIds.size} (IDs: ${[...corruptIds].join(", ")})`,
      );
    }

    if (changesToEnrich.length === 0) {
      console.log(`[index] [${activeMode}] All files up-to-date. Skipping.`);
      continue;
    }

    let enriched = 0;
    const total = changesToEnrich.length;

    const tasks = changesToEnrich.map((change) => async () => {
      const num = Number(change._number);
      const label = `#${num} – ${String(change.subject).slice(0, 50)}`;
      const tag = corruptIds.has(num) ? " [RE-FETCH]" : "";
      console.log(
        `[index] [${activeMode}] Enriching [${++enriched}/${total}]${tag} ${label}`,
      );

      let result: unknown;
      if (activeMode === "metadata") {
        result = await enrichMetadata(client, change);
      } else if (activeMode === "patchsets") {
        result = await enrichPatchsets(client, change);
      } else if (activeMode === "diffs") {
        result = await enrichDiffs(client, change);
      } else {
        result = await enrichComments(client, change);
      }

      return { num, result };
    });

    await runWithSlidingWindow(tasks, concurrency, ({ num, result }) => {
      writer.write(num, activeMode, result);
    });

    console.log(`[index] [${activeMode}] Completed ✓`);
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Gerrit Data Collection Complete ✓`);
  console.log("═".repeat(60));
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
