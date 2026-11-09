// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import {
  FILESYSTEM_LIST_DIRECTORY_LIMIT,
  FILESYSTEM_WRITE_BYTES_MAX,
  FilesystemOperationError,
  type FilesystemDirectoryEntry,
  type FilesystemListDirectoryInput,
  type FilesystemListDirectoryResult,
  type FilesystemMutateInput,
  type FilesystemMutateResult,
  type FilesystemOperationFailure,
  type FilesystemWriteBytesInput,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";

/** Whole-host file management for the file explorer, unlike the workspace-scoped services. */
export class HostFiles extends Context.Service<
  HostFiles,
  {
    readonly listDirectory: (
      input: FilesystemListDirectoryInput,
    ) => Effect.Effect<FilesystemListDirectoryResult, FilesystemOperationError>;
    readonly mutate: (
      input: FilesystemMutateInput,
    ) => Effect.Effect<FilesystemMutateResult, FilesystemOperationError>;
    readonly writeBytes: (
      input: FilesystemWriteBytesInput,
    ) => Effect.Effect<FilesystemMutateResult, FilesystemOperationError>;
  }
>()("t3/workspace/HostFiles") {}

const STAT_BATCH_SIZE = 64;

function failureOf(cause: unknown): FilesystemOperationFailure {
  switch ((cause as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT":
      return "not_found";
    case "EEXIST":
    case "ENOTEMPTY":
      return "already_exists";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission_denied";
    case "ENOTDIR":
      return "not_directory";
    case "EINVAL":
    case "ENAMETOOLONG":
      return "invalid_path";
    default:
      return "failed";
  }
}

const FAILURE_MESSAGES: Record<FilesystemOperationFailure, string> = {
  not_found: "does not exist",
  already_exists: "already exists",
  permission_denied: "is not accessible to the server",
  not_directory: "is not a folder",
  invalid_path: "is not a valid path",
  failed: "could not be changed",
};

function operationError(operation: string, path: string, cause: unknown) {
  const failure = failureOf(cause);
  return new FilesystemOperationError({
    operation,
    path,
    failure,
    message: `'${path}' ${FAILURE_MESSAGES[failure]}.`,
    cause,
  });
}

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const resolve = Effect.fn("HostFiles.resolve")(function* (operation: string, input: string) {
    const expanded = expandHomePath(input, yield* HostProcess.HomeDirectory);
    if (!path.isAbsolute(expanded)) {
      return yield* new FilesystemOperationError({
        operation,
        path: input,
        failure: "invalid_path",
        message: `'${input}' must be an absolute path.`,
      });
    }
    return path.resolve(expanded);
  });

  const realPath = (value: string) => NodeFSP.realpath(value).catch(() => path.resolve(value));

  // Clients must not break the server by deleting or overwriting its own database or secrets.
  const guardWritable = Effect.fn("HostFiles.guardWritable")(function* (
    operation: string,
    target: string,
  ) {
    const [file, stateDir, secretsDir] = yield* Effect.promise(() =>
      Promise.all([realPath(target), realPath(config.stateDir), realPath(config.secretsDir)]),
    );
    const touchesServerState = [stateDir, secretsDir].some(
      (root) => isWithinRoot(path, file, root) || isWithinRoot(path, root, file),
    );
    if (touchesServerState) {
      return yield* new FilesystemOperationError({
        operation,
        path: target,
        failure: "permission_denied",
        message: `'${target}' holds T3 Code's own data and cannot be changed from here.`,
      });
    }
  });

  const attempt = <A>(operation: string, target: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => operationError(operation, target, cause) });

  const listDirectory: HostFiles["Service"]["listDirectory"] = Effect.fn("HostFiles.listDirectory")(
    function* (input) {
      const directory = yield* resolve("list", input.path);
      const dirents = yield* attempt("list", directory, () =>
        NodeFSP.readdir(directory, { withFileTypes: true }),
      );
      const truncated = dirents.length > FILESYSTEM_LIST_DIRECTORY_LIMIT;
      const visible = dirents.slice(0, FILESYSTEM_LIST_DIRECTORY_LIMIT);
      const entries: Array<FilesystemDirectoryEntry> = [];
      for (let index = 0; index < visible.length; index += STAT_BATCH_SIZE) {
        const batch = yield* Effect.promise(() =>
          Promise.all(
            visible.slice(index, index + STAT_BATCH_SIZE).map(async (dirent) => {
              const full = path.join(directory, dirent.name);
              // Follow symlinks for kind and size; a dangling one is listed as "other".
              const stats = await NodeFSP.stat(full).catch(() => null);
              const kind = stats?.isDirectory()
                ? "directory"
                : stats?.isFile()
                  ? "file"
                  : ("other" as const);
              return {
                name: dirent.name,
                kind,
                symlink: dirent.isSymbolicLink(),
                ...(stats?.isFile() ? { byteLength: stats.size } : {}),
                ...(stats ? { modifiedAt: Math.max(0, Math.floor(stats.mtimeMs)) } : {}),
              } satisfies FilesystemDirectoryEntry;
            }),
          ),
        );
        entries.push(...batch);
      }
      const parent = path.dirname(directory);
      return {
        path: directory,
        parentPath: parent === directory ? null : parent,
        homePath: yield* HostProcess.HomeDirectory,
        separator: path.sep === "\\" ? "\\" : "/",
        entries,
        truncated,
      };
    },
  );

  const mutate: HostFiles["Service"]["mutate"] = Effect.fn("HostFiles.mutate")(function* (input) {
    switch (input._tag) {
      case "createDirectory": {
        const target = yield* resolve("createDirectory", input.path);
        yield* guardWritable("createDirectory", target);
        yield* attempt("createDirectory", target, () => NodeFSP.mkdir(target));
        return { paths: [target] };
      }
      case "createFile": {
        const target = yield* resolve("createFile", input.path);
        yield* guardWritable("createFile", target);
        yield* attempt("createFile", target, () => NodeFSP.writeFile(target, "", { flag: "wx" }));
        return { paths: [target] };
      }
      case "rename":
      case "copy": {
        const from = yield* resolve(input._tag, input.from);
        const to = yield* resolve(input._tag, input.to);
        if (input._tag === "rename") yield* guardWritable(input._tag, from);
        yield* guardWritable(input._tag, to);
        if (isWithinRoot(path, to, from) && from !== to) {
          return yield* new FilesystemOperationError({
            operation: input._tag,
            path: to,
            failure: "invalid_path",
            message: `A folder cannot be moved or copied into itself.`,
          });
        }
        const exists = yield* Effect.promise(() =>
          NodeFSP.lstat(to).then(
            () => true,
            () => false,
          ),
        );
        // A case-only rename on a case-insensitive disk finds the source itself at `to`.
        if (exists && !(input._tag === "rename" && from.toLowerCase() === to.toLowerCase())) {
          return yield* operationError(
            input._tag,
            to,
            Object.assign(new Error(), { code: "EEXIST" }),
          );
        }
        yield* attempt(input._tag, from, () =>
          input._tag === "rename"
            ? NodeFSP.rename(from, to).catch((cause: NodeJS.ErrnoException) =>
                // rename cannot cross devices, so a move between disks copies and then deletes.
                cause.code === "EXDEV"
                  ? NodeFSP.cp(from, to, {
                      recursive: true,
                      errorOnExist: true,
                      force: false,
                    }).then(() => NodeFSP.rm(from, { recursive: true }))
                  : Promise.reject(cause),
              )
            : NodeFSP.cp(from, to, {
                recursive: true,
                errorOnExist: true,
                force: false,
                verbatimSymlinks: true,
              }),
        );
        return { paths: input._tag === "rename" ? [from, to] : [to] };
      }
      case "delete": {
        const targets: Array<string> = [];
        for (const raw of input.paths) {
          const target = yield* resolve("delete", raw);
          if (path.dirname(target) === target) {
            return yield* new FilesystemOperationError({
              operation: "delete",
              path: target,
              failure: "invalid_path",
              message: "The root folder cannot be deleted.",
            });
          }
          yield* guardWritable("delete", target);
          targets.push(target);
        }
        for (const target of targets) {
          yield* attempt("delete", target, () => NodeFSP.rm(target, { recursive: true }));
        }
        return { paths: targets };
      }
    }
  });

  const writeBytes: HostFiles["Service"]["writeBytes"] = Effect.fn("HostFiles.writeBytes")(
    function* (input) {
      const target = yield* resolve("upload", input.path);
      yield* guardWritable("upload", target);
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.byteLength > FILESYSTEM_WRITE_BYTES_MAX) {
        return yield* new FilesystemOperationError({
          operation: "upload",
          path: target,
          failure: "invalid_path",
          message: "The file is larger than 32 MB.",
        });
      }
      yield* attempt("upload", target, () =>
        NodeFSP.writeFile(target, bytes, { flag: input.overwrite ? "w" : "wx" }),
      );
      return { paths: [target] };
    },
  );

  return HostFiles.of({ listDirectory, mutate, writeBytes });
});

export const layer = Layer.effect(HostFiles, make);
