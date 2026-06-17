/**
 * @file gerrit-client.ts
 * @description HTTP client for the Gerrit REST API.
 *
 * Handles:
 *  - Stripping the magic ")]}'" XSSI protection prefix from every response.
 *  - Paginating through all changes using the _more_changes flag + `S` param.
 *  - Per-change supplementary calls:
 *      - GET /changes/{id}/revisions/{rev}/commit   → full commit message
 *      - GET /changes/{id}/revisions/{rev}/files    → file list per patchset
 *      - GET /changes/{id}/revisions/{rev}/files/{file}/diff → unified diff
 *      - GET /changes/{id}/comments                 → inline comments
 *
 * Gerrit REST API reference:
 * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html
 */

import fetch from "node-fetch";
import type {
  AccountInfo,
  ChangeInfo,
} from "@gerritcodereview/typescript-api/rest-api";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Gerrit prefixes every JSON response with this string to prevent XSSI attacks.
 * https://gerrit-review.googlesource.com/Documentation/rest-api.html#output
 */
const GERRIT_XSSI_PREFIX = ")]}'\n" as const;

/** Maximum page size for the /changes/ list endpoint. */
const PAGE_SIZE = 100 as const;

/**
 * Query options to attach to the main changes list request.
 * DETAILED_ACCOUNTS  → AccountInfo objects include name/email/username.
 * ALL_REVISIONS      → All patchset RevisionInfo entries are returned inline.
 * MESSAGES           → The change-level message thread is included inline.
 */
const LIST_OPTIONS: readonly string[] = [
  "DETAILED_ACCOUNTS",
  "ALL_REVISIONS",
  "MESSAGES",
] as const;

// ─── Raw API response shapes ──────────────────────────────────────────────────

/**
 * ChangeInfo extended with the pagination flag returned on the last item.
 */
type RawChangeListItem = ChangeInfo & {
  readonly _more_changes?: true;
};

/**
 * Minimal shape of the CommitInfo returned by
 * GET /changes/{id}/revisions/{rev}/commit
 */
export interface RawCommitInfo {
  readonly message?: string;
  readonly subject?: string;
}

/**
 * Minimal shape of a single entry in
 * GET /changes/{id}/revisions/{rev}/files
 * Key is the file path; value is FileInfo.
 */
export interface RawFileInfo {
  readonly status?: string; // 'A' | 'D' | 'R' | 'C' | 'W'
  readonly binary?: boolean;
  readonly old_path?: string;
  readonly lines_inserted?: number;
  readonly lines_deleted?: number;
}

export type RawFilesResponse = Record<string, RawFileInfo>;

/**
 * Minimal shape of a DiffContent chunk returned by
 * GET /changes/{id}/revisions/{rev}/files/{file}/diff
 */
export interface RawDiffContent {
  readonly a?: string[]; // lines from the old file
  readonly b?: string[]; // lines from the new file
}

export interface RawDiffInfo {
  readonly binary?: boolean;
  readonly content: RawDiffContent[];
}

/**
 * Minimal shape of a CommentInfo entry returned by
 * GET /changes/{id}/comments
 * The response is a map of file-path → CommentInfo[].
 */
export interface RawCommentInfo {
  readonly id: string;
  readonly patch_set?: number;
  readonly line?: number;
  readonly message?: string;
  readonly author?: AccountInfo;
  readonly updated: string;
  readonly in_reply_to?: string;
  readonly unresolved?: boolean;
  readonly tag?: string;
}

export type RawCommentsResponse = Record<string, RawCommentInfo[]>;

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Removes the Gerrit XSSI prefix and parses the body as JSON.
 */
function parseGerritJson<T>(raw: string): T {
  if (!raw.startsWith(GERRIT_XSSI_PREFIX)) {
    throw new Error(
      `Unexpected Gerrit response – missing XSSI prefix.\n` +
        `First 120 chars: ${raw.slice(0, 120)}`,
    );
  }
  return JSON.parse(raw.slice(GERRIT_XSSI_PREFIX.length)) as T;
}

/**
 * URL-encodes a file path for use in Gerrit REST endpoints.
 * Gerrit uses the same percent-encoding as standard URIs, but slashes inside
 * a path component must also be encoded (they are path separators otherwise).
 */
function encodeFilePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("%2F");
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GerritClient {
  private readonly baseUrl: string;

  /**
   * @param baseUrl  Root URL of the Gerrit instance, e.g. "https://gerrit.onap.org/r".
   *                 Trailing slash is normalised away.
   */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ─── Low-level fetch ───────────────────────────────────────────────────────

  /**
   * Performs a GET request and returns the parsed, XSSI-stripped JSON body.
   * All errors produce a descriptive Error with the URL included.
   */
  private async getJson<T>(url: URL | string): Promise<T> {
    const href = url instanceof URL ? url.toString() : url;

    const response = await fetch(href, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `Gerrit API error: ${response.status} ${response.statusText}\nURL: ${href}`,
      );
    }

    const text = await response.text();
    return parseGerritJson<T>(text);
  }

  // ─── Change list ──────────────────────────────────────────────────────────

  /**
   * Fetches ALL changes matching the given query, automatically following
   * the _more_changes pagination signal.
   *
   * @param query  Gerrit search expression (default: "is:open").
   * @param limit  Optional hard cap on the total number of changes returned.
   */
  async fetchAllChanges(
    query: string = "is:open",
    limit?: number,
  ): Promise<ChangeInfo[]> {
    const accumulated: ChangeInfo[] = [];
    let start = 0;

    console.log(`[GerritClient] Fetching changes: query="${query}"`);

    while (true) {
      const pageSize = limit
        ? Math.min(PAGE_SIZE, limit - accumulated.length)
        : PAGE_SIZE;

      const url = new URL(`${this.baseUrl}/changes/`);
      url.searchParams.set("q", query);
      url.searchParams.set("n", String(pageSize));
      url.searchParams.set("S", String(start));
      for (const opt of LIST_OPTIONS) {
        url.searchParams.append("o", opt);
      }

      console.log(`[GerritClient] → page start=${start}, n=${pageSize}`);

      const page = await this.getJson<RawChangeListItem[]>(url);

      if (!Array.isArray(page) || page.length === 0) break;

      accumulated.push(...page);
      console.log(
        `[GerritClient] ← ${page.length} items (total: ${accumulated.length})`,
      );

      if (limit !== undefined && accumulated.length >= limit) {
        console.log(`[GerritClient] Limit of ${limit} reached.`);
        break;
      }

      if (!page[page.length - 1]._more_changes) {
        console.log(`[GerritClient] No more pages.`);
        break;
      }

      start += page.length;
    }

    return accumulated;
  }

  // ─── Commit info ──────────────────────────────────────────────────────────

  /**
   * Returns the full CommitInfo for a specific patchset.
   *
   * GET /changes/{change-id}/revisions/{revision-id}/commit
   * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#get-commit
   *
   * @param changeId   The numeric change ID (_number).
   * @param revisionId Commit SHA or "current".
   */
  async fetchCommitInfo(
    changeId: number,
    revisionId: string,
  ): Promise<RawCommitInfo> {
    const url = new URL(
      `${this.baseUrl}/changes/${changeId}/revisions/${revisionId}/commit`,
    );
    return this.getJson<RawCommitInfo>(url);
  }

  // ─── File list ────────────────────────────────────────────────────────────

  /**
   * Returns the map of files modified in a specific patchset.
   *
   * GET /changes/{change-id}/revisions/{revision-id}/files
   * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#list-files
   *
   * @param changeId   The numeric change ID (_number).
   * @param revisionId Commit SHA or "current".
   */
  async fetchFiles(
    changeId: number,
    revisionId: string,
  ): Promise<RawFilesResponse> {
    const url = new URL(
      `${this.baseUrl}/changes/${changeId}/revisions/${revisionId}/files`,
    );
    return this.getJson<RawFilesResponse>(url);
  }

  // ─── File diff ────────────────────────────────────────────────────────────

  /**
   * Returns the unified diff of a single file in a patchset.
   *
   * GET /changes/{change-id}/revisions/{revision-id}/files/{file-id}/diff
   * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#get-diff
   *
   * @param changeId   The numeric change ID (_number).
   * @param revisionId Commit SHA or "current".
   * @param filePath   The file path as returned by fetchFiles().
   */
  async fetchFileDiff(
    changeId: number,
    revisionId: string,
    filePath: string,
  ): Promise<RawDiffInfo> {
    const encodedPath = encodeFilePath(filePath);
    const url = new URL(
      `${this.baseUrl}/changes/${changeId}/revisions/${revisionId}/files/${encodedPath}/diff`,
    );
    // intraline=false keeps the response small; we only need the hunk lines.
    url.searchParams.set("intraline", "false");
    return this.getJson<RawDiffInfo>(url);
  }

  // ─── Inline comments ──────────────────────────────────────────────────────

  /**
   * Returns all published inline comments on a change, keyed by file path.
   *
   * GET /changes/{change-id}/comments
   * https://gerrit-review.googlesource.com/Documentation/rest-api-changes.html#list-change-comments
   *
   * @param changeId The numeric change ID (_number).
   */
  async fetchComments(changeId: number): Promise<RawCommentsResponse> {
    const url = new URL(`${this.baseUrl}/changes/${changeId}/comments`);
    return this.getJson<RawCommentsResponse>(url);
  }
}
