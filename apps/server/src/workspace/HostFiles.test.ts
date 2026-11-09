// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as HostFiles from "./HostFiles.ts";

const layerTest = HostFiles.layer.pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-host-files-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-host-files-" });
  const hostFiles = yield* HostFiles.HostFiles;
  return { root, join: (...parts: string[]) => path.join(root, ...parts), hostFiles };
});

it.layer(layerTest)("HostFiles", (it) => {
  describe("mutate", () => {
    it.effect("creates, renames, copies and deletes without overwriting", () =>
      Effect.gen(function* () {
        const { join, hostFiles, root } = yield* setup;
        yield* hostFiles.mutate({ _tag: "createDirectory", path: join("docs") });
        yield* hostFiles.mutate({ _tag: "createFile", path: join("docs", "a.txt") });
        yield* hostFiles.writeBytes({
          path: join("docs", "a.txt"),
          base64: Buffer.from("hello").toString("base64"),
          overwrite: true,
        });
        yield* hostFiles.mutate({ _tag: "copy", from: join("docs"), to: join("copy") });
        yield* hostFiles.mutate({
          _tag: "rename",
          from: join("copy", "a.txt"),
          to: join("b.txt"),
        });
        expect(yield* Effect.promise(() => NodeFSP.readFile(join("b.txt"), "utf8"))).toBe("hello");

        const clash = yield* hostFiles
          .mutate({ _tag: "rename", from: join("b.txt"), to: join("docs", "a.txt") })
          .pipe(Effect.flip);
        expect(clash.failure).toBe("already_exists");
        const intoItself = yield* hostFiles
          .mutate({ _tag: "copy", from: join("docs"), to: join("docs", "inner") })
          .pipe(Effect.flip);
        expect(intoItself.failure).toBe("invalid_path");

        yield* hostFiles.mutate({ _tag: "delete", paths: [join("docs"), join("copy")] });
        const listing = yield* hostFiles.listDirectory({ path: root });
        expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.byteLength])).toEqual([
          ["b.txt", "file", 5],
        ]);
        expect(listing.parentPath).not.toBeNull();
      }),
    );

    it.effect("refuses to change the server's own state", () =>
      Effect.gen(function* () {
        const { hostFiles } = yield* setup;
        const config = yield* ServerConfig.ServerConfig;
        const error = yield* hostFiles
          .mutate({ _tag: "delete", paths: [config.stateDir] })
          .pipe(Effect.flip);
        expect(error.failure).toBe("permission_denied");
        const relative = yield* hostFiles
          .listDirectory({ path: "relative/path" })
          .pipe(Effect.flip);
        expect(relative.failure).toBe("invalid_path");
      }),
    );
  });
});
