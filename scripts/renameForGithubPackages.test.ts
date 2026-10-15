import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  chooseBuildVersion,
  PackageManifest,
  packageBaseVersion,
  renameForGithubPackages,
} from "./renameForGithubPackages";
import * as Schema from "effect/Schema";
import { publishedPackages } from "./checkPackContents";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const internalPeers = {
  cli: {
    "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7",
    "@confect/server": "npm:@englever/confect-server@10.2.0-englever.7",
  },
  core: {},
  foldkit: {
    "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7",
    "@confect/js": "npm:@englever/confect-js@10.2.0-englever.7",
  },
  js: { "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7" },
  react: { "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7" },
  server: { "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7" },
  test: {
    "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7",
    "@confect/server": "npm:@englever/confect-server@10.2.0-englever.7",
  },
};

test.each(Object.entries(internalPeers))(
  "renames the real %s manifest without changing its input",
  (name, peers) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const input = yield* fs
          .readFileString(
            new URL(`../packages/${name}/package.json`, import.meta.url)
              .pathname,
          )
          .pipe(
            Effect.flatMap(
              Schema.decodeEffect(Schema.fromJsonString(PackageManifest)),
            ),
          );
        const before = encodeJson(input);
        const output = renameForGithubPackages(input, "10.2.0-englever.7");
        expect(output).toMatchObject({
          name: `@englever/confect-${name}`,
          version: "10.2.0-englever.7",
          repository: {
            type: "git",
            url: "git+https://github.com/englever/confect.git",
          },
          publishConfig: { registry: "https://npm.pkg.github.com" },
          exports: input.exports,
        });
        expect(
          Object.fromEntries(
            Object.entries(output.peerDependencies ?? {}).filter(([key]) =>
              key.startsWith("@confect/"),
            ),
          ),
        ).toEqual(peers);
        expect(output.peerDependencies?.effect).toBe(
          input.peerDependencies?.effect,
        );
        expect(output.devDependencies).toBeUndefined();
        expect(output.scripts).toBeUndefined();
        expect(encodeJson(input)).toBe(before);
      }).pipe(Effect.provide(BunServices.layer)),
    ),
);

test("rewrites all internal dependency maps and retains external ranges and metadata", () => {
  const output = renameForGithubPackages(
    {
      name: "@confect/js",
      version: "10.2.0",
      dependencies: { "@confect/core": "workspace:*", effect: "^4.0.0" },
      optionalDependencies: { "@confect/server": "workspace:^" },
      peerDependencies: { "@confect/core": "^10.2.0" },
      peerDependenciesMeta: { "@confect/core": { optional: true } },
      publishConfig: { access: "public" },
    },
    "10.2.0-englever.7",
  );
  expect(output).toMatchObject({
    dependencies: {
      "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7",
      effect: "^4.0.0",
    },
    optionalDependencies: {
      "@confect/server": "npm:@englever/confect-server@10.2.0-englever.7",
    },
    peerDependencies: {
      "@confect/core": "npm:@englever/confect-core@10.2.0-englever.7",
    },
    peerDependenciesMeta: { "@confect/core": { optional: true } },
    publishConfig: { access: "public", registry: "https://npm.pkg.github.com" },
  });
});

test("starts at one and advances past the highest published build for this base", () => {
  expect(Result.getOrThrow(chooseBuildVersion("10.2.0", []))).toBe(
    "10.2.0-englever.1",
  );
  expect(
    Result.getOrThrow(
      chooseBuildVersion("10.2.0", [
        "10.2.0-englever.2",
        "10.2.0-englever.10",
        "10.3.0-englever.99",
        "10.2.0-next.90",
        "10.2.0-englever.11.extra",
      ]),
    ),
  ).toBe("10.2.0-englever.11");
  expect(
    Result.getOrThrow(
      chooseBuildVersion("10.2.0", ["10.2.0-englever.10"], "30"),
    ),
  ).toBe("10.2.0-englever.30");
});

test.each(["0", "-1", "1.5", "1e2", "01", "abc", "9007199254740992"])(
  "rejects invalid explicit build number %s",
  (value) => {
    const result = chooseBuildVersion("10.2.0", [], value);
    expect(Result.isFailure(result) && result.failure._tag).toBe(
      "InvalidBuildVersion",
    );
  },
);

test("rejects a prerelease base and exhausted build numbers", () => {
  for (const result of [
    chooseBuildVersion("10.2.0-next.1", []),
    chooseBuildVersion("10.2.0", ["10.2.0-englever.9007199254740991"]),
  ]) {
    expect(Result.isFailure(result) && result.failure._tag).toBe(
      "InvalidBuildVersion",
    );
  }
});

test("rejects an explicit version that any package has already published", () => {
  const result = chooseBuildVersion("10.2.0", ["10.2.0-englever.7"], "7");
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "BuildNumberUnavailable",
    version: "10.2.0-englever.7",
    highestBuild: 7,
  });
});

test("never accepts dry-run as a build number", () => {
  const result = chooseBuildVersion("10.2.0", [], "dry-run");
  expect(Result.isFailure(result) && result.failure._tag).toBe(
    "InvalidBuildVersion",
  );
});

test("requires all source packages to share the core base version", () => {
  const core = { name: "@confect/core", version: "10.2.0" };
  expect(
    Result.getOrThrow(
      packageBaseVersion([
        core,
        { name: "@confect/server", version: "10.2.0" },
      ]),
    ),
  ).toBe("10.2.0");
  const mismatch = packageBaseVersion([
    core,
    { name: "@confect/server", version: "10.3.0" },
  ]);
  expect(Result.isFailure(mismatch) && mismatch.failure).toMatchObject({
    _tag: "PackageVersionMismatch",
    packageName: "@confect/server",
    expected: "10.2.0",
    actual: "10.3.0",
  });
  const missing = packageBaseVersion([
    { name: "@confect/server", version: "10.2.0" },
  ]);
  expect(Result.isFailure(missing) && missing.failure).toMatchObject({
    _tag: "MissingCorePackage",
    packages: ["@confect/server"],
  });
});

test("rejects an unused override below the highest existing number", () => {
  const result = chooseBuildVersion("10.2.0", ["10.2.0-englever.10"], "7");
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "BuildNumberUnavailable",
    version: "10.2.0-englever.7",
    highestBuild: 10,
  });
});

test("has rewrite fixtures for every published package", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directories = yield* publishedPackages();
      expect(directories.sort()).toEqual(
        Object.keys(internalPeers)
          .map((name) => `packages/${name}`)
          .sort(),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  ));
