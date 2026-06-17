/**
 * @file mapper.ts
 * @description Transforms raw Gerrit API objects into the strongly-typed
 *              ChangeMetadata output records defined in types.ts.
 *
 * This is the only module that knows about both the @gerritcodereview API
 * shape and the project-specific output shape.
 */

import type {
  AccountInfo,
  ChangeInfo,
} from "@gerritcodereview/typescript-api/rest-api";
import type {
  ChangeAccountMapping,
  ChangeComment,
  ChangeLog,
  ChangeLogEntry,
  ChangeMetadata,
  ChangeTimestamps,
  CodeContent,
  DiscussionContext,
  FileDiff,
  DiffHunk,
  InlineComment,
  PatchsetDiscussion,
  PatchsetInfo,
  ResolvedAccount,
} from "./types";
import type {
  RawCommentsResponse,
  RawCommentInfo,
  RawCommitInfo,
  RawDiffInfo,
  RawFilesResponse,
} from "./gerrit-client";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants  — must be declared before any function that references them
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The Gerrit key used for patchset-level (non-file) comments in the
 * comments map returned by GET /changes/{id}/comments.
 */
const PATCHSET_LEVEL_KEY = "/PATCHSET_LEVEL";

// ═══════════════════════════════════════════════════════════════════════════════
// Account helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maps an AccountInfo (from DETAILED_ACCOUNTS) to a ResolvedAccount.
 * All optional fields are coerced to null for deterministic JSON output.
 */
export function mapAccount(
  account: AccountInfo | undefined,
): ResolvedAccount | null {
  if (account === undefined) return null;
  return {
    account_id: account._account_id ?? null,
    name: account.name ?? null,
    display_name: account.display_name ?? null,
    email: account.email ?? null,
    username: account.username ?? null,
  };
}

/** Same as mapAccount but throws for mandatory fields like `owner`. */
function mapRequiredAccount(
  account: AccountInfo | undefined,
  field: string,
): ResolvedAccount {
  const resolved = mapAccount(account);
  if (resolved === null) {
    throw new Error(`[mapper] Required account field "${field}" is missing.`);
  }
  return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change-level metadata mappers
// ═══════════════════════════════════════════════════════════════════════════════

function mapTimestamps(change: ChangeInfo): ChangeTimestamps {
  return {
    created: change.created,
    updated: change.updated,
    submitted: change.submitted ?? null,
  };
}

function mapChangeAccounts(change: ChangeInfo): ChangeAccountMapping {
  return {
    owner: mapRequiredAccount(change.owner, "owner"),
    submitter: mapAccount(change.submitter),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Comment mappers  — declared before mapCodeContent which calls them
// ═══════════════════════════════════════════════════════════════════════════════

function mapSingleInlineComment(
  filePath: string,
  c: RawCommentInfo,
): InlineComment {
  return {
    id: c.id,
    file_path: filePath,
    patchset_number: c.patch_set ?? null,
    line: c.line ?? null,
    message: c.message ?? null,
    author: mapAccount(c.author),
    updated: c.updated as ReturnType<typeof String> as any,
    in_reply_to: c.in_reply_to ?? null,
    unresolved: c.unresolved ?? null,
  };
}

function mapSingleChangeComment(c: RawCommentInfo): ChangeComment {
  return {
    id: c.id,
    patchset_number: c.patch_set ?? null,
    message: c.message ?? null,
    author: mapAccount(c.author),
    updated: c.updated as ReturnType<typeof String> as any,
    in_reply_to: c.in_reply_to ?? null,
    unresolved: c.unresolved ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Diff mapper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a RawDiffInfo (from the /diff endpoint) and a file path into a
 * FileDiff output record.
 */
export function mapFileDiff(
  filePath: string,
  rawDiff: RawDiffInfo,
  oldPath: string | null,
): FileDiff {
  const isBinary = rawDiff.binary === true;

  const hunks: DiffHunk[] = isBinary
    ? []
    : rawDiff.content.map((chunk) => ({
        before: chunk.a != null ? { lines: chunk.a } : null,
        after: chunk.b != null ? { lines: chunk.b } : null,
      }));

  return {
    file_path: filePath,
    is_binary: isBinary,
    old_path: oldPath,
    hunks,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Patchset mapper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a PatchsetInfo record from the RevisionInfo already embedded in the
 * ChangeInfo (via ALL_REVISIONS) plus the file diffs and per-patchset
 * reviewer comments.
 *
 * @param revisionSha   The 40-char commit SHA (key from change.revisions map).
 * @param revisionInfo  The RevisionInfo value from that map.
 * @param fileDiffs     Pre-fetched FileDiff records for this patchset.
 * @param discussion    Reviewer comments scoped to this patchset number.
 */
export function mapPatchset(
  revisionSha: string,
  revisionInfo: {
    _number?: number;
    created?: string;
    uploader?: AccountInfo;
    [key: string]: unknown;
  },
  fileDiffs: FileDiff[],
  discussion: PatchsetDiscussion,
): PatchsetInfo {
  return {
    patchset_number: revisionInfo._number ?? 0,
    commit_sha: revisionSha,
    uploader: mapAccount(revisionInfo.uploader),
    created: (revisionInfo.created ?? "") as any,
    file_diffs: fileDiffs,
    discussion,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CodeContent mapper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assembles the CodeContent section of the output.
 *
 * Comments from rawComments are partitioned by patch_set number and embedded
 * directly into the matching PatchsetInfo.discussion. Comments whose patch_set
 * is absent are returned as part of the unmatched bucket (handled by the
 * caller via mapDiscussion).
 *
 * @param change           Raw ChangeInfo (includes subject + revisions map).
 * @param commitInfo       Commit message fetched from the current revision.
 * @param filesPerRevision Map of revisionSha → RawFilesResponse.
 * @param diffsPerRevision Map of revisionSha → filePath → RawDiffInfo.
 * @param rawComments      All published comments from GET /changes/{id}/comments.
 */
export function mapCodeContent(
  change: ChangeInfo,
  commitInfo: RawCommitInfo,
  filesPerRevision: Map<string, RawFilesResponse>,
  diffsPerRevision: Map<string, Map<string, RawDiffInfo>>,
  rawComments: RawCommentsResponse,
): CodeContent {
  // ── Partition all comments by patchset number ──────────────────────────────
  // Key = patchset number (1-based). Key -1 = no patch_set field on comment.
  const patchsetCommentsMap = new Map<number, ChangeComment[]>();
  const inlineCommentsMap = new Map<number, InlineComment[]>();

  for (const [filePath, comments] of Object.entries(rawComments)) {
    for (const c of comments) {
      const psNum: number = c.patch_set ?? -1;

      if (filePath === PATCHSET_LEVEL_KEY) {
        // Patchset-level comment (not attached to a file).
        if (!patchsetCommentsMap.has(psNum)) patchsetCommentsMap.set(psNum, []);
        patchsetCommentsMap.get(psNum)!.push(mapSingleChangeComment(c));
      } else {
        // Per-file inline comment.
        if (!inlineCommentsMap.has(psNum)) inlineCommentsMap.set(psNum, []);
        inlineCommentsMap.get(psNum)!.push(mapSingleInlineComment(filePath, c));
      }
    }
  }

  const byDate = <T extends { updated: unknown }>(a: T, b: T): number =>
    String(a.updated).localeCompare(String(b.updated));

  // ── Build one PatchsetInfo per revision ───────────────────────────────────
  const revisions = change.revisions ?? {};
  const patchsets: PatchsetInfo[] = Object.entries(revisions)
    .map(([sha, revInfo]) => {
      const rawFiles = filesPerRevision.get(sha) ?? {};
      const diffMap =
        diffsPerRevision.get(sha) ?? new Map<string, RawDiffInfo>();

      // Build file diffs for this patchset (skip the virtual /COMMIT_MSG file).
      const fileDiffs: FileDiff[] = Object.keys(rawFiles)
        .filter((p) => p !== "/COMMIT_MSG")
        .map((filePath) => {
          const rawDiff = diffMap.get(filePath);
          const oldPath = rawFiles[filePath]?.old_path ?? null;
          if (!rawDiff) {
            // Diff was not fetched (binary file or fetch error); return placeholder.
            return {
              file_path: filePath,
              is_binary: rawFiles[filePath]?.binary === true,
              old_path: oldPath,
              hunks: [],
            } satisfies FileDiff;
          }
          return mapFileDiff(filePath, rawDiff, oldPath);
        });

      // Patchset number from the RevisionInfo embedded in the ChangeInfo.
      const psNumber = (revInfo as { _number?: number })._number ?? 0;

      // Pull comments that belong to this patchset number.
      const discussion: PatchsetDiscussion = {
        patchset_comments: (patchsetCommentsMap.get(psNumber) ?? [])
          .slice()
          .sort(byDate),
        inline_comments: (inlineCommentsMap.get(psNumber) ?? [])
          .slice()
          .sort(byDate),
      };

      return mapPatchset(
        sha,
        revInfo as unknown as Parameters<typeof mapPatchset>[1],
        fileDiffs,
        discussion,
      );
    })
    // Sort ascending by patchset number so PS 1 comes first.
    .sort((a, b) => a.patchset_number - b.patchset_number);

  // ── Flat deduplicated file path list across all patchsets ─────────────────
  const allPaths = new Set<string>();
  for (const ps of patchsets) {
    for (const fd of ps.file_diffs) {
      allPaths.add(fd.file_path);
    }
  }

  return {
    subject: change.subject,
    commit_message: commitInfo.message ?? null,
    modified_file_paths: [...allPaths].sort(),
    patchsets,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Discussion context mapper  (unmatched / no-patchset comments)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds the change-level DiscussionContext containing ONLY comments that
 * could not be matched to any known patchset (patch_set field was absent).
 *
 * All patchset-scoped comments are embedded in each PatchsetInfo.discussion
 * by mapCodeContent. This function captures the remainder so no data is lost.
 *
 * @param rawComments        All comments from GET /changes/{id}/comments.
 * @param knownPatchsetNums  Patchset numbers that were processed; comments
 *                           whose patch_set matches one of these are skipped.
 */
export function mapDiscussion(
  rawComments: RawCommentsResponse,
  knownPatchsetNums: Set<number>,
): DiscussionContext {
  const changeComments: ChangeComment[] = [];
  const inlineComments: InlineComment[] = [];

  for (const [filePath, comments] of Object.entries(rawComments)) {
    for (const c of comments) {
      // Skip if this comment already belongs to a known patchset.
      if (c.patch_set !== undefined && knownPatchsetNums.has(c.patch_set)) {
        continue;
      }
      if (filePath === PATCHSET_LEVEL_KEY) {
        changeComments.push(mapSingleChangeComment(c));
      } else {
        inlineComments.push(mapSingleInlineComment(filePath, c));
      }
    }
  }

  changeComments.sort((a, b) =>
    String(a.updated).localeCompare(String(b.updated)),
  );
  inlineComments.sort((a, b) =>
    String(a.updated).localeCompare(String(b.updated)),
  );

  return { change_comments: changeComments, inline_comments: inlineComments };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change log mapper  (Gerrit message audit trail)
// ═══════════════════════════════════════════════════════════════════════════════

type AuthorRole = ChangeLogEntry["author_role"];

/**
 * Infers the author's role within the change from the message metadata and
 * the change's owner account ID.
 */
function resolveAuthorRole(
  message: { author?: AccountInfo; tag?: string },
  ownerAccountId: number | undefined,
): AuthorRole {
  if (message.tag?.startsWith("autogenerated")) return "CI_BOT";
  const authorId = message.author?._account_id;
  if (authorId === undefined) return "UNKNOWN";
  if (authorId === ownerAccountId) return "OWNER";
  return "REVIEWER";
}

/**
 * Maps the inline message array from ChangeInfo (populated by the MESSAGES
 * query option) into the ChangeLog output.
 */
export function mapChangeLog(change: ChangeInfo): ChangeLog {
  const rawMessages = change.messages ?? [];
  const ownerAccountId = change.owner?._account_id as number | undefined;

  const entries: ChangeLogEntry[] = rawMessages.map((m) => ({
    id: String(m.id),
    author: mapAccount(m.author),
    author_role: resolveAuthorRole(m, ownerAccountId),
    timestamp: m.date,
    message: m.message,
    patchset_number:
      (m as { _revision_number?: number })._revision_number ?? null,
  }));

  return { entry_count: entries.length, entries };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Top-level mapper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts one raw ChangeInfo plus all supplementary fetched data into the
 * typed ChangeMetadata record.
 */
export function mapChangeToMetadata(
  change: ChangeInfo,
  commitInfo: RawCommitInfo,
  filesPerRevision: Map<string, RawFilesResponse>,
  diffsPerRevision: Map<string, Map<string, RawDiffInfo>>,
  rawComments: RawCommentsResponse,
): ChangeMetadata {
  // Build code content — this also partitions comments into each patchset.
  const code = mapCodeContent(
    change,
    commitInfo,
    filesPerRevision,
    diffsPerRevision,
    rawComments,
  );

  return {
    id: change.id,
    change_id: change.change_id,
    _number: change._number,
    status: change.status,
    timestamps: mapTimestamps(change),
    accounts: mapChangeAccounts(change),
    code,
    change_log: mapChangeLog(change),
  };
}
