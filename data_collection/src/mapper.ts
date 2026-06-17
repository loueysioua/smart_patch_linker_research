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
  FileDiff,
  DiffHunk,
  InlineComment,
  PatchsetInfo,
  PatchsetDiff,
  ChangeComments,
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
// Mode-specific mappers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts one raw ChangeInfo plus commit info into the typed ChangeMetadata record.
 */
export function mapChangeToMetadata(
  change: ChangeInfo,
  commitInfo: RawCommitInfo,
): ChangeMetadata {
  return {
    id: change.id,
    change_id: change.change_id,
    _number: change._number,
    status: change.status,
    timestamps: mapTimestamps(change),
    accounts: mapChangeAccounts(change),
    subject: change.subject,
    commit_message: commitInfo.message ?? null,
    change_log: mapChangeLog(change),
  };
}

/**
 * Maps revisions in ChangeInfo to an array of PatchsetInfo.
 */
export function mapChangePatchsets(
  change: ChangeInfo,
  filesPerRevision: Map<string, RawFilesResponse>,
): PatchsetInfo[] {
  const revisions = change.revisions ?? {};
  return Object.entries(revisions)
    .map(([sha, revInfo]) => {
      const rawFiles = filesPerRevision.get(sha) ?? {};
      const modified_file_paths = Object.keys(rawFiles)
        .filter((p) => p !== "/COMMIT_MSG")
        .sort();
      const psNumber = (revInfo as { _number?: number })._number ?? 0;

      return {
        patchset_number: psNumber,
        commit_sha: sha,
        uploader: mapAccount((revInfo as any).uploader),
        created: ((revInfo as any).created ?? "") as any,
        modified_file_paths,
      };
    })
    .sort((a, b) => a.patchset_number - b.patchset_number);
}

/**
 * Maps revisions and their fetched diffs to PatchsetDiff[].
 */
export function mapChangeDiffs(
  change: ChangeInfo,
  diffsPerRevision: Map<string, Map<string, RawDiffInfo>>,
  filesPerRevision: Map<string, RawFilesResponse>,
): PatchsetDiff[] {
  const revisions = change.revisions ?? {};
  return Object.entries(revisions)
    .map(([sha, revInfo]) => {
      const rawFiles = filesPerRevision.get(sha) ?? {};
      const diffMap = diffsPerRevision.get(sha) ?? new Map<string, RawDiffInfo>();

      const fileDiffs: FileDiff[] = Object.keys(rawFiles)
        .filter((p) => p !== "/COMMIT_MSG")
        .map((filePath) => {
          const rawDiff = diffMap.get(filePath);
          const oldPath = rawFiles[filePath]?.old_path ?? null;
          if (!rawDiff) {
            return {
              file_path: filePath,
              is_binary: rawFiles[filePath]?.binary === true,
              old_path: oldPath,
              hunks: [],
            };
          }
          return mapFileDiff(filePath, rawDiff, oldPath);
        });

      const psNumber = (revInfo as { _number?: number })._number ?? 0;

      return {
        patchset_number: psNumber,
        commit_sha: sha,
        file_diffs: fileDiffs,
      };
    })
    .sort((a, b) => a.patchset_number - b.patchset_number);
}

/**
 * Maps comments to ChangeComments.
 */
export function mapChangeComments(
  change: ChangeInfo,
  rawComments: RawCommentsResponse,
): ChangeComments {
  const changeComments: ChangeComment[] = [];
  const inlineComments: InlineComment[] = [];

  for (const [filePath, comments] of Object.entries(rawComments)) {
    for (const c of comments) {
      if (filePath === PATCHSET_LEVEL_KEY) {
        changeComments.push(mapSingleChangeComment(c));
      } else {
        inlineComments.push(mapSingleInlineComment(filePath, c));
      }
    }
  }

  const byDate = <T extends { updated: unknown }>(a: T, b: T): number =>
    String(a.updated).localeCompare(String(b.updated));

  changeComments.sort(byDate);
  inlineComments.sort(byDate);

  return {
    id: change.id,
    change_id: change.change_id,
    _number: change._number,
    change_comments: changeComments,
    inline_comments: inlineComments,
  };
}
