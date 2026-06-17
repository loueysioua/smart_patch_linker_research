/**
 * @file types.ts
 * @description Strongly-typed output models for Gerrit Change-Level Metadata,
 *              Code Retrieval Features, and Discussion Context.
 *
 * These types are derived from the official Gerrit REST API definitions
 * exposed by @gerritcodereview/typescript-api.
 *
 * Gerrit API reference:
 * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html
 */

import type {
  AccountId,
  ChangeId,
  ChangeInfoId,
  ChangeStatus,
  NumericChangeId,
  Timestamp,
} from "@gerritcodereview/typescript-api/rest-api";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared primitives
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A resolved, serialisable representation of a Gerrit account.
 * Mirrors AccountInfo from the REST API while guaranteeing that all fields
 * stored in the output are plain JSON-compatible primitives.
 */
export interface ResolvedAccount {
  /** Internal Gerrit numeric account ID. May be absent for email-only CCs. */
  readonly account_id: AccountId | null;
  /** Human-readable full name of the account. */
  readonly name: string | null;
  /** Display name if different from the full name. */
  readonly display_name: string | null;
  /** Primary email address. */
  readonly email: string | null;
  /** Gerrit username. */
  readonly username: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change-Level Metadata
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * All timestamp fields relevant at the change level.
 * Timestamps are returned by Gerrit in UTC with nanosecond precision:
 * "yyyy-MM-dd HH:mm:ss.nnnnnnnnn"
 */
export interface ChangeTimestamps {
  /** When the change was first uploaded. */
  readonly created: Timestamp;
  /** When the change (or any of its metadata) was last touched. */
  readonly updated: Timestamp;
  /**
   * When the change was merged or abandoned.
   * Absent for changes that are still open (NEW status).
   */
  readonly submitted: Timestamp | null;
}

/**
 * All account roles associated with a single change.
 */
export interface ChangeAccountMapping {
  /** The account that created / owns the change. */
  readonly owner: ResolvedAccount;
  /**
   * The account that submitted (merged / applied) the change.
   * Null when the change has not been submitted.
   */
  readonly submitter: ResolvedAccount | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Code Retrieval Features
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One side of a diff hunk (before or after the change).
 * Maps to the `a` / `b` arrays within a DiffContent entity.
 * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#diff-content
 */
export interface DiffSide {
  /** Lines belonging to this side of the hunk. */
  readonly lines: string[];
}

/**
 * A single unified diff hunk for one file in one patchset.
 * Each entry in the array represents a contiguous changed region.
 */
export interface DiffHunk {
  /**
   * Lines that were in the old version of the file (removed / context).
   * Null when the hunk is a pure addition.
   */
  readonly before: DiffSide | null;
  /**
   * Lines that appear in the new version of the file (added / context).
   * Null when the hunk is a pure deletion.
   */
  readonly after: DiffSide | null;
}

/**
 * Diff information for a single file path within a specific patchset.
 */
export interface FileDiff {
  /** The file path being diffed (relative to the repository root). */
  readonly file_path: string;
  /**
   * Whether the file is binary.
   * When true, `hunks` will be an empty array (binary diffs are not textual).
   */
  readonly is_binary: boolean;
  /**
   * The old file path when the file was renamed or copied.
   * Null if the file was not renamed.
   */
  readonly old_path: string | null;
  /** List of changed hunks, in order. */
  readonly hunks: DiffHunk[];
}

/**
 * Reviewer comments scoped to a single patchset.
 * Populated from GET /changes/{id}/comments, filtered to entries whose
 * `patch_set` field matches this patchset's number.
 */
export interface PatchsetDiscussion {
  /**
   * Patchset-level comments not attached to any file (from the
   * `/PATCHSET_LEVEL` key in the Gerrit comments map).
   * Sorted chronologically.
   */
  readonly patchset_comments: ChangeComment[];
  /**
   * Per-file, per-line inline review comments left on this patchset.
   * Sorted chronologically.
   */
  readonly inline_comments: InlineComment[];
}

/**
 * A single code revision (patchset) of a change, including uploader, created, and modified file paths.
 */
export interface PatchsetInfo {
  /**
   * The 1-based patchset number.
   * (Maps to RevisionInfo._number in the Gerrit API.)
   */
  readonly patchset_number: number;
  /**
   * The full 40-character SHA-1 commit hash for this patchset.
   */
  readonly commit_sha: string;
  /** The account that uploaded this patchset. */
  readonly uploader: ResolvedAccount | null;
  /** UTC timestamp when this patchset was uploaded. */
  readonly created: Timestamp;
  /** List of file paths modified in this specific patchset. */
  readonly modified_file_paths: string[];
}

/**
 * File diffs for a specific patchset.
 */
export interface PatchsetDiff {
  readonly patchset_number: number;
  readonly commit_sha: string;
  readonly file_diffs: FileDiff[];
}

/**
 * All comments for a single change, grouped at the change metadata level.
 */
export interface ChangeComments {
  readonly id: ChangeInfoId;
  readonly change_id: ChangeId;
  readonly _number: NumericChangeId;
  readonly change_comments: ChangeComment[];
  readonly inline_comments: InlineComment[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change Log  (formerly "discussion")
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single entry in the Gerrit change message audit log.
 * This includes CI bot posts, patchset upload notices, vote notifications,
 * and any other system-generated or user-authored messages that appear in
 * the change timeline.
 *
 * Maps to ChangeMessageInfo.
 * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#change-message-info
 */
export interface ChangeLogEntry {
  /** Unique identifier of the message. */
  readonly id: string;
  /** Account that authored the message. */
  readonly author: ResolvedAccount | null;
  /**
   * Role label for the author (e.g. "OWNER", "REVIEWER", "CI_BOT").
   * Derived heuristically: if the message tag starts with "autogenerated",
   * the role is "CI_BOT"; otherwise it is resolved from the change's
   * reviewer / owner mapping.
   */
  readonly author_role: "OWNER" | "REVIEWER" | "CC" | "CI_BOT" | "UNKNOWN";
  /** UTC timestamp of the message. */
  readonly timestamp: Timestamp;
  /** The full text body of the message. */
  readonly message: string;
  /**
   * The patchset this message is associated with.
   * Null for change-level messages not tied to a specific patchset.
   */
  readonly patchset_number: number | null;
}

/**
 * The audit trail of all change-level messages (CI bots, vote events,
 * patchset upload notices, etc.) as returned by the MESSAGES query option.
 */
export interface ChangeLog {
  /** Total number of entries in the log. */
  readonly entry_count: number;
  /** Ordered list of entries (chronological, oldest first). */
  readonly entries: ChangeLogEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Discussion Context  (human code-review comments)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A published inline comment left on a specific file / line during code review.
 * Maps to the CommentInfo entity.
 * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#comment-info
 */
export interface InlineComment {
  /** Unique identifier of the comment (URL-encoded). */
  readonly id: string;
  /** The file path the comment is attached to. */
  readonly file_path: string;
  /**
   * The patchset number the comment was left on.
   * Null in the rare case the patchset is unknown.
   */
  readonly patchset_number: number | null;
  /**
   * The specific line number within the file.
   * Null for file-level comments (not tied to a specific line).
   */
  readonly line: number | null;
  /** The comment text. */
  readonly message: string | null;
  /** Account that authored the comment. */
  readonly author: ResolvedAccount | null;
  /** UTC timestamp when the comment was last updated. */
  readonly updated: Timestamp;
  /**
   * ID of the parent comment if this is a reply.
   * Null for top-level comments.
   */
  readonly in_reply_to: string | null;
  /**
   * Whether the comment thread is still unresolved.
   * Null if the field was not returned by the API.
   */
  readonly unresolved: boolean | null;
}

/**
 * A published change-level (patchset-level) comment — not attached to any
 * specific file line, but left as a top-level review comment.
 * Gerrit surfaces these under the `/PATCHSET_LEVEL` key in the comments map.
 */
export interface ChangeComment {
  /** Unique identifier of the comment. */
  readonly id: string;
  /**
   * The patchset number the comment was left on.
   * Null in the rare case the patchset is unknown.
   */
  readonly patchset_number: number | null;
  /** The comment text. */
  readonly message: string | null;
  /** Account that authored the comment. */
  readonly author: ResolvedAccount | null;
  /** UTC timestamp when the comment was last updated. */
  readonly updated: Timestamp;
  /**
   * ID of the parent comment if this is a reply.
   * Null for top-level comments.
   */
  readonly in_reply_to: string | null;
  /**
   * Whether the comment thread is still unresolved.
   * Null if the field was not returned by the API.
   */
  readonly unresolved: boolean | null;
}

/**
 * Reviewer comments that could NOT be matched to any known patchset
 * (i.e. the comment's `patch_set` field was absent in the API response).
 *
 * In practice this is almost always empty. The primary per-patchset discussion
 * lives in each PatchsetInfo.discussion inside CodeContent.patchsets.
 *
 * Both lists are sourced from GET /changes/{id}/comments.
 */
export interface DiscussionContext {
  /**
   * Patchset-level comments (from `/PATCHSET_LEVEL`) whose patchset could
   * not be determined. Sorted chronologically.
   */
  readonly change_comments: ChangeComment[];
  /**
   * Inline comments whose patchset could not be determined.
   * Sorted chronologically.
   */
  readonly inline_comments: InlineComment[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Top-level output shapes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The canonical metadata record for a single Gerrit change.
 */
export interface ChangeMetadata {
  // ── Change-Level Metadata ──────────────────────────────────────────────────

  /**
   * The compound change identifier in the format
   * "<project>~<branch>~<Change-Id>".
   */
  readonly id: ChangeInfoId;

  /**
   * The human-readable Change-Id that appears in commit messages,
   * starting with the letter "I".
   */
  readonly change_id: ChangeId;

  /**
   * Internal numeric identifier of the change, unique within the Gerrit
   * instance. This is the number shown in the Gerrit UI URL.
   */
  readonly _number: NumericChangeId;

  /**
   * The lifecycle status of the change.
   * One of: NEW | MERGED | ABANDONED
   */
  readonly status: ChangeStatus;

  /** All timestamp fields for this change. */
  readonly timestamps: ChangeTimestamps;

  /** All account roles mapped to this change. */
  readonly accounts: ChangeAccountMapping;

  // ── Code Retrieval Features (Metadata portion) ─────────────────────────────

  /** The one-line summary / title of the change. */
  readonly subject: string;
  /** The full commit message text of the current (latest) patchset. */
  readonly commit_message: string | null;

  // ── Change Log ─────────────────────────────────────────────────────────────

  /**
   * The audit trail of all change-level messages.
   */
  readonly change_log: ChangeLog;
}

// ─── Collection Output ────────────────────────────────────────────────────────

/**
 * Top-level JSON output shape written to disk.
 */
export interface GerritDataOutput {
  /** ISO-8601 datetime at which the collection run was executed. */
  readonly collected_at: string;
  /** The Gerrit instance base URL that was queried. */
  readonly source_url: string;
  /** Total number of changes retrieved. */
  readonly total_changes: number;
  /** Ordered list of change metadata records. */
  readonly changes: ChangeMetadata[];
}
