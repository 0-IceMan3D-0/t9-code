import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FILESYSTEM_METADATA_BATCH_LIMIT = 64;

export const FilesystemGetMetadataInput = Schema.Struct({
  // Absolute host paths, including ~/; clients must anchor relative paths.
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(FILESYSTEM_METADATA_BATCH_LIMIT)),
});
export type FilesystemGetMetadataInput = typeof FilesystemGetMetadataInput.Type;

export const FilesystemEntryMetadata = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "other"]),
  byteLength: Schema.optionalKey(NonNegativeInt),
  mimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesystemEntryMetadata = typeof FilesystemEntryMetadata.Type;

// Entries follow request order; null means missing, unreadable, or unsupported.
export const FilesystemGetMetadataResult = Schema.Struct({
  entries: Schema.Array(Schema.NullOr(FilesystemEntryMetadata)),
});
export type FilesystemGetMetadataResult = typeof FilesystemGetMetadataResult.Type;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    /** Set when the directory does not exist; older clients ignore it. */
    pathMissing: Schema.optional(Schema.Boolean),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly pathMissing?: boolean;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

const FilesystemPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const FILESYSTEM_LIST_DIRECTORY_LIMIT = 5000;
export const FILESYSTEM_WRITE_BYTES_MAX = 32 * 1024 * 1024;

export const FilesystemListDirectoryInput = Schema.Struct({
  // Absolute host path or ~/; `~` alone is the home directory.
  path: FilesystemPath,
});
export type FilesystemListDirectoryInput = typeof FilesystemListDirectoryInput.Type;

export const FilesystemDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory", "other"]),
  symlink: Schema.Boolean,
  byteLength: Schema.optionalKey(NonNegativeInt),
  modifiedAt: Schema.optionalKey(NonNegativeInt),
});
export type FilesystemDirectoryEntry = typeof FilesystemDirectoryEntry.Type;

export const FilesystemListDirectoryResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  parentPath: Schema.NullOr(TrimmedNonEmptyString),
  homePath: TrimmedNonEmptyString,
  separator: Schema.Literals(["/", "\\"]),
  entries: Schema.Array(FilesystemDirectoryEntry),
  truncated: Schema.Boolean,
});
export type FilesystemListDirectoryResult = typeof FilesystemListDirectoryResult.Type;

export const FilesystemMutateInput = Schema.Union([
  Schema.TaggedStruct("createDirectory", { path: FilesystemPath }),
  Schema.TaggedStruct("createFile", { path: FilesystemPath }),
  // Also moves: `to` may name another directory.
  Schema.TaggedStruct("rename", { from: FilesystemPath, to: FilesystemPath }),
  Schema.TaggedStruct("copy", { from: FilesystemPath, to: FilesystemPath }),
  Schema.TaggedStruct("delete", {
    paths: Schema.Array(FilesystemPath).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
]);
export type FilesystemMutateInput = typeof FilesystemMutateInput.Type;

export const FilesystemMutateResult = Schema.Struct({
  // Absolute paths created or changed, so clients can refresh their listings.
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type FilesystemMutateResult = typeof FilesystemMutateResult.Type;

export const FilesystemWriteBytesInput = Schema.Struct({
  path: FilesystemPath,
  base64: Schema.String.check(Schema.isMaxLength(Math.ceil(FILESYSTEM_WRITE_BYTES_MAX / 3) * 4)),
  overwrite: Schema.Boolean,
});
export type FilesystemWriteBytesInput = typeof FilesystemWriteBytesInput.Type;

export const FilesystemOperationFailure = Schema.Literals([
  "not_found",
  "already_exists",
  "permission_denied",
  "not_directory",
  "invalid_path",
  "failed",
]);
export type FilesystemOperationFailure = typeof FilesystemOperationFailure.Type;

export class FilesystemOperationError extends Schema.TaggedError<FilesystemOperationError>()(
  "FilesystemOperationError",
  {
    operation: TrimmedNonEmptyString,
    path: Schema.String,
    failure: FilesystemOperationFailure,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
