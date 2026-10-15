import { FunctionSpec, GroupSpec } from "@confect/core";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, expect, layer } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import {
  codegenHandler,
  validateNoParentChildNameCollisions,
} from "@confect/cli/confect/codegen";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import {
  specImportPathFromGenerated,
  type LeafModule,
} from "@confect/cli/LeafModule";
import {
  discover as discoverTables,
  validate as validateTables,
} from "@confect/cli/TableModule";
import { toPosixPath } from "@confect/cli/utils";
import {
  HandWrittenConvexFileError,
  InvalidDeclarationError,
} from "@confect/cli/CodegenError";
import * as Project from "./integration/Project";

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler",
  (it) => {
    it.effect(
      "bootstraps dependent modules once without relying on stale output",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const confect = path.join(project.root, "confect");
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(confect),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          expect((yield* run).anyWritesHappened).toBe(true);
          expect((yield* run).anyWritesHappened).toBe(false);
          yield* fs.remove(path.join(confect, "_generated"), {
            recursive: true,
          });
          expect((yield* run).anyWritesHappened).toBe(true);
          expect((yield* run).anyWritesHappened).toBe(false);
        }).pipe(Effect.scoped),
    );
  },
);

const fixtureConfect = `${import.meta.dirname}/../../server/test/mock-backend/fixtures/confect`;

const CodegenLayer = Layer.mergeAll(
  NodePath.layer,
  NodeFileSystem.layer,
  Layer.succeed(
    ConfectDirectory,
    ConfectDirectory.of({ get: Effect.succeed(fixtureConfect) }),
  ),
);

layer(CodegenLayer)("TableModule.discover", (it) => {
  it.effect("discovers the fixture tables", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tables = yield* discoverTables;
      expect(tables.map((t) => t.tableName).sort()).toEqual([
        "events",
        "notes",
        "tags",
        "users",
      ]);
      for (const table of tables) {
        expect(String.startsWith(`tables${path.sep}`)(table.relativePath)).toBe(
          true,
        );
      }
    }),
  );

  it.effect(
    "rejects a `confect/tables/*.ts` file that does not default-export an UnnamedTable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stowedPath = path.join(fixtureConfect, "tables", "stowed.ts");

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(stowedPath, "export default {};\n");
          const tables = yield* discoverTables;
          const result = yield* Effect.result(validateTables(tables));

          assert(Result.isFailure(result));
          expect(result.failure._tag).toBe("InvalidTableDefaultExportError");
        }).pipe(Effect.ensuring(fs.remove(stowedPath).pipe(Effect.orDie)));
      }),
  );

  // Each rejected filename exercises a different validator branch:
  //   - "user-profiles.ts" violates the JS identifier pattern (dash).
  //   - "_internal.ts" starts with `_`, which is reserved for Convex system
  //     tables and excluded by `validateConfectTableIdentifier` even though
  //     `_internal` is a legal JS identifier.
  //   - "import.ts" is a legal-looking identifier but a reserved JS keyword,
  //     so emitting it as a binding in generated files would fail to parse.
  it.effect.each(["user-profiles.ts", "_internal.ts", "import.ts"])(
    "rejects table filename %s",
    (filename) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const invalidPath = path.join(fixtureConfect, "tables", filename);

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(invalidPath, "export default {};\n");
          const result = yield* Effect.result(discoverTables);

          assert(Result.isFailure(result));
          expect(result.failure._tag).toBe("InvalidTableFilenameError");
        }).pipe(Effect.ensuring(fs.remove(invalidPath).pipe(Effect.orDie)));
      }),
  );

  // Names are derived from the basename alone, but the directory is scanned
  // recursively—so two files in different subdirectories can resolve to the
  // same table name. That must fail loudly rather than racing on a shared
  // generated wrapper path/emitting duplicate schema bindings. Two distinct
  // colliding names are seeded so we can assert that *all* collisions are
  // captured in a single pass, not just the first.
  it.effect("rejects every set of files that resolve to the same name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const tablesDir = path.join(tempDir, "tables");
      yield* fs.makeDirectory(path.join(tablesDir, "a"), { recursive: true });
      yield* fs.makeDirectory(path.join(tablesDir, "b"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "users.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "users.ts"),
        "export default {};\n",
      );

      const result = yield* Effect.result(
        discoverTables.pipe(
          Effect.provide(
            Layer.succeed(
              ConfectDirectory,
              ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
            ),
          ),
        ),
      );

      assert(Result.isFailure(result));
      assert(result.failure._tag === "DuplicateTableNameError");
      const byName = Object.fromEntries(
        result.failure.collisions.map((c) => [
          c.tableName,
          [...c.tablePaths].sort(),
        ]),
      );
      expect(byName).toEqual({
        notes: [
          path.join("tables", "a", "notes.ts"),
          path.join("tables", "b", "notes.ts"),
        ],
        users: [
          path.join("tables", "a", "users.ts"),
          path.join("tables", "b", "users.ts"),
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty array when there is no tables/ directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped();

      const tables = yield* discoverTables.pipe(
        Effect.provide(
          Layer.succeed(
            ConfectDirectory,
            ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
          ),
        ),
      );

      expect(tables).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // The "tables/ exists but has no .ts files" branch in `listTableFiles`
  // is structurally distinct from the missing-directory branch above
  // (different early return path) and deserves its own regression test;
  // both branches collapse to an empty result, which the codegen pipeline
  // promotes into a `⚠` warning at the call site (see `warnIfNoTables`).
  it.effect(
    "returns an empty array when tables/ exists but has no .ts files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped();
        const tablesDir = path.join(tempDir, "tables");
        yield* fs.makeDirectory(tablesDir);
        yield* fs.writeFileString(path.join(tablesDir, ".gitkeep"), "");
        yield* fs.writeFileString(
          path.join(tablesDir, "README.md"),
          "tables go here\n",
        );

        const tables = yield* discoverTables.pipe(
          Effect.provide(
            Layer.succeed(
              ConfectDirectory,
              ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
            ),
          ),
        );

        expect(tables).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

const leaf = (
  relativePath: string,
  pathSegments: [string, ...string[]],
): LeafModule => ({
  relativePath,
  pathSegments,
  groupPathDot: pathSegments.join("."),
  exportName: pathSegments[pathSegments.length - 1]!,
  runtime: Option.none(),
  specImportPath: `../${relativePath.slice(0, -".ts".length)}`,
});

const emptyReturns = Schema.Null;

layer(Layer.empty)("validateNoParentChildNameCollisions", (it) => {
  it.effect("accepts non-colliding parent-with-children layouts", () =>
    Effect.gen(function* () {
      const parent = leaf("notes.spec.ts", ["notes"]);
      const child = leaf("notes/archived.spec.ts", ["notes", "archived"]);
      const parentGroupSpec = GroupSpec.make().addFunction(
        FunctionSpec.publicQuery({
          name: "list",
          returns: () => emptyReturns,
        }),
      );

      yield* validateNoParentChildNameCollisions(
        [parent, child],
        new Map([[parent.relativePath, parentGroupSpec]]),
      );
    }),
  );

  it.effect(
    "fails when a parent function name matches a sibling subdirectory segment",
    () =>
      Effect.gen(function* () {
        const parent = leaf("notes.spec.ts", ["notes"]);
        const child = leaf("notes/archived.spec.ts", ["notes", "archived"]);
        const parentGroupSpec = GroupSpec.make().addFunction(
          FunctionSpec.publicQuery({
            name: "archived",
            returns: () => emptyReturns,
          }),
        );

        const result = yield* Effect.result(
          validateNoParentChildNameCollisions(
            [parent, child],
            new Map([[parent.relativePath, parentGroupSpec]]),
          ),
        );

        assert(Result.isFailure(result));
        expect(result.failure._tag).toBe("ParentChildNameCollisionError");
        expect(result.failure.collisionKind).toBe("function");
        expect(result.failure.collisionName).toBe("archived");
        expect(result.failure.parentSpecPath).toBe("notes.spec.ts");
        expect(result.failure.childSpecPath).toBe("notes/archived.spec.ts");
      }),
  );

  it.effect(
    "fails when a parent addGroupAt name matches a sibling subdirectory segment",
    () =>
      Effect.gen(function* () {
        const parent = leaf("notes.spec.ts", ["notes"]);
        const child = leaf("notes/archived.spec.ts", ["notes", "archived"]);
        const inner = GroupSpec.makeAt("inner").addFunction(
          FunctionSpec.publicQuery({
            name: "list",
            returns: () => emptyReturns,
          }),
        );
        const parentGroupSpec = GroupSpec.make().addGroupAt("archived", inner);

        const result = yield* Effect.result(
          validateNoParentChildNameCollisions(
            [parent, child],
            new Map([[parent.relativePath, parentGroupSpec]]),
          ),
        );

        assert(Result.isFailure(result));
        expect(result.failure._tag).toBe("ParentChildNameCollisionError");
        expect(result.failure.collisionKind).toBe("group");
        expect(result.failure.collisionName).toBe("archived");
      }),
  );

  it.effect("ignores collisions when there is no parent leaf", () =>
    Effect.gen(function* () {
      const child = leaf("notes/archived.spec.ts", ["notes", "archived"]);

      yield* validateNoParentChildNameCollisions([child], new Map());
    }),
  );
});

const leafFor = Effect.fnUntraced(function* (
  relativePath: string,
  pathSegments: [string, ...string[]],
) {
  const specImportPath = yield* specImportPathFromGenerated(relativePath);
  return {
    relativePath,
    pathSegments,
    groupPathDot: Array.join(pathSegments, "."),
    exportName: pathSegments[pathSegments.length - 1]!,
    runtime: Option.none(),
    specImportPath,
  } satisfies LeafModule;
});

for (const { name, pathLayer, sep } of [
  { name: "posix", pathLayer: NodePath.layerPosix, sep: "/" },
  { name: "win32", pathLayer: NodePath.layerWin32, sep: "\\" },
] as const) {
  layer(pathLayer)(
    `validateNoParentChildNameCollisions, discovered as ${name}`,
    (it) => {
      it.effect(
        "detects a collision when the leaf path and its specifier differ in separator",
        () =>
          Effect.gen(function* () {
            const parent = yield* leafFor("notes.spec.ts", ["notes"]);
            const child = yield* leafFor(`notes${sep}archived.spec.ts`, [
              "notes",
              "archived",
            ]);
            const parentGroupSpec = GroupSpec.make().addFunction(
              FunctionSpec.publicQuery({
                name: "archived",
                returns: () => emptyReturns,
              }),
            );

            const path = yield* Path.Path;
            const result = yield* Effect.result(
              validateNoParentChildNameCollisions(
                [parent, child],
                new Map([
                  [toPosixPath(path, parent.relativePath), parentGroupSpec],
                ]),
              ),
            );

            assert(Result.isFailure(result));
            expect(result.failure._tag).toBe("ParentChildNameCollisionError");
            expect(result.failure.collisionName).toBe("archived");
          }),
      );
    },
  );
}

const declarationProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* Project.make;
  yield* fs.makeDirectory(
    path.join(project.root, "components/counter/convex"),
    {
      recursive: true,
    },
  );
  yield* project.write(
    "components/counter/convex/convex.config.ts",
    `import { defineComponent } from "convex/server";
import { v } from "convex/values";
export default defineComponent("counter", { env: { REQUIRED: v.string(), MARKER: v.optional(v.string()) } });
`,
  );
  yield* project.write(
    "components/counter/api.ts",
    `import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
export const CounterApi = HttpApi.make("counter").add(
  HttpApiGroup.make("health").add(HttpApiEndpoint.get("health", "/health", { success: Schema.String })),
);
`,
  );
  yield* project.write(
    "confect/env.ts",
    `import { Env } from "@confect/core";
export default Env.make("host", {
  MARKER: Env.optional(Env.string()),
  API_KEY: Env.secret(),
  MODE: Env.literals(["live", "test"]),
});
`,
  );
  yield* project.write(
    "confect/app.ts",
    `import { App } from "@confect/core";
import counter from "../components/counter/convex/convex.config";
import { CounterApi } from "../components/counter/api";
import env from "./env";
export default App.make({
  env,
  mounts: {
    first: App.mount(counter, { httpPrefix: "/first", api: CounterApi, env: { REQUIRED: "first-required", MARKER: env.MARKER } }),
    second: App.mount(counter, { env: { REQUIRED: env.API_KEY } }),
  },
});
`,
  );
  yield* project.write(
    "confect/auth.ts",
    `import { Auth } from "@confect/core";
import app from "./app";
export default Auth.make(app, {
  providers: [
    { type: "customJwt", applicationID: "host", issuer: Auth.siteUrl(), jwks: Auth.siteUrl(app.mounts.first, "/jwks.json"), algorithm: "RS256" },
    { domain: "https://login.example.test", applicationID: "host" },
  ],
});
`,
  );
  const http = (routePath: string) => `import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(
  HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", ${JSON.stringify(routePath)}, { success: Schema.String })),
);
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("status", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers });
`;
  yield* project.write("confect/http.ts", http("/status"));
  const run = codegenHandler.pipe(
    Effect.provideService(ProjectRoot, { get: Effect.succeed(project.root) }),
    Effect.provideService(ConfectDirectory, {
      get: Effect.succeed(path.join(project.root, "confect")),
    }),
    Effect.provideService(ConvexDirectory, {
      get: Effect.succeed(path.join(project.root, "convex")),
    }),
  );
  const read = (file: string) =>
    fs.readFileString(path.join(project.root, file));
  const exists = (file: string) => fs.exists(path.join(project.root, file));
  return { ...project, run, read, exists, http };
});

const expectedConvexConfig = `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineApp } from "convex/server";
import { v } from "convex/values";
import counter from "../components/counter/convex/convex.config";

const app = defineApp({
  env: {
    MARKER: v.optional(v.string()),
    API_KEY: v.string(),
    MODE: v.union(v.literal("live"), v.literal("test")),
  },
});

app.use(counter, {
  name: "first",
  httpPrefix: "/first",
  env: {
    REQUIRED: "first-required",
    MARKER: app.env.MARKER,
  },
});

app.use(counter, {
  name: "second",
  env: {
    REQUIRED: app.env.API_KEY,
  },
});

export default app;
`;

const expectedAuthConfig = `// Generated by \`confect codegen\` from confect/auth.ts. Do not edit.
import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "host",
      issuer: \`\${process.env.CONVEX_SITE_URL}\`,
      jwks: \`\${process.env.CONVEX_SITE_URL}/first/jwks.json\`,
      algorithm: "RS256",
    },
    {
      domain: "https://login.example.test",
      applicationID: "host",
    },
  ],
} satisfies AuthConfig;
`;

const expectedManifest = (
  digest: string,
) => `// Generated by \`confect codegen\` from confect/env.ts and confect/app.ts. Do not edit.

export default {
  "name": "host",
  "env": {
    "MARKER": {
      "kind": "string",
      "optional": true
    },
    "API_KEY": {
      "kind": "secret",
      "optional": false
    },
    "MODE": {
      "kind": "literals",
      "values": [
        "live",
        "test"
      ],
      "optional": false
    }
  },
  "http": {
    "mounts": {
      "first": "/first"
    }
  },
  "digest": "${digest}"
} as const;
`;

const expectedHttp = `import { HttpRouter } from "@confect/server";
import schema from "../confect/_generated/schema";
import http from "../confect/http";

export default HttpRouter.forSchema(schema)(http.routes);
`;

const digestOf = (manifest: string) =>
  /"digest": "(sha256:[0-9a-f]{64})"/.exec(manifest)?.[1] ?? "missing";

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler with a backend declaration",
  (it) => {
    it.effect(
      "writes the Convex config, auth config, HTTP router and manifest from confect/",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          expect((yield* project.run).anyWritesHappened).toBe(true);
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            expectedConvexConfig,
          );
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
          expect(yield* project.read("convex/http.ts")).toBe(expectedHttp);
          const manifest = yield* project.read(
            "confect/_generated/manifest.ts",
          );
          expect(manifest).toBe(expectedManifest(digestOf(manifest)));
          expect(
            yield* project.read("confect/_generated/components.ts"),
          ).toContain('"first": import(');
          expect((yield* project.run).anyWritesHappened).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "changes the manifest digest when a declaration input changes",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.run;
          const before = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          yield* project.write(
            "components/counter/api.ts",
            `${yield* project.read("components/counter/api.ts")}// edited\n`,
          );
          yield* project.run;
          const after = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          expect(after).not.toBe(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects an app route under a mount's HTTP prefix",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "confect/http.ts",
            project.http("/first/status"),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/http.ts",
              reason:
                'The app route GET /first/status is under the HTTP prefix /first of the mount "first". Convex would let it shadow the component\'s routes; move it or change the prefix.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects overlapping mount prefixes without a confect/http.ts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              "env: { REQUIRED: env.API_KEY }",
              'httpPrefix: "/first/nested", env: { REQUIRED: env.API_KEY }',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason:
                'The mounts "first" (/first) and "second" (/first/nested) have overlapping HTTP prefixes.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses to overwrite a hand-written convex.config.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const handWritten = `import { defineApp } from "convex/server";\nexport default defineApp();\n`;
          yield* project.write("convex/convex.config.ts", handWritten);
          expect(yield* Effect.flip(project.run)).toEqual(
            new HandWrittenConvexFileError({
              convexPath: "convex/convex.config.ts",
              declarationPath: "confect/app.ts",
            }),
          );
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            handWritten,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "replaces the auth.config.ts re-export an earlier codegen wrote",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "convex/auth.config.ts",
            'import auth from "../confect/auth";\n\nexport default auth;\n',
          );
          yield* project.run;
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the manifest when the declaration stops producing one",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          yield* fs.remove(path.join(project.root, "confect/auth.ts"));
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            'export default { env: "not an app" };\n',
          );
          expect((yield* Effect.flip(project.run))._tag).toBe(
            "InvalidDeclarationError",
          );
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
