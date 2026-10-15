import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  checkRebase,
  inspectRelease,
  planRebase,
  selectReleaseTag,
} from "./rebaseOntoRelease";

test("selects the newest stable core release numerically", () => {
  expect(
    Result.getOrThrow(
      selectReleaseTag([
        "@confect/core@10.2.0",
        "@confect/server@99.0.0",
        "@confect/core@11.0.0-next.9",
        "@confect/core@10.10.0",
        "@confect/core@10.9.99",
        "@confect/core@010.20.0",
      ]),
    ),
  ).toBe("@confect/core@10.10.0");
});

test("reports when no stable core release is available", () => {
  const result = selectReleaseTag(["@confect/core@10.0.0-next.9", "v10.2.0"]);
  expect(Result.isFailure(result) && result.failure._tag).toBe(
    "NoStableCoreRelease",
  );
});

test("keeps fork patches when their upstream base is already the selected release", () => {
  expect(
    planRebase({
      tag: "@confect/core@10.2.0",
      target: "release",
      base: "release",
      forkHead: "fork-patch",
    }),
  ).toEqual({
    _tag: "AlreadyCurrent",
    tag: "@confect/core@10.2.0",
    target: "release",
    base: "release",
    forkHead: "fork-patch",
  });
  expect(
    planRebase({
      tag: "@confect/core@10.3.0",
      target: "new-release",
      base: "old-release",
      forkHead: "fork-patch",
    }),
  ).toEqual({
    _tag: "Rebase",
    tag: "@confect/core@10.3.0",
    target: "new-release",
    base: "old-release",
    forkHead: "fork-patch",
  });
});

const makeHistory = (conflict = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-rebase-history-",
    });
    const root = yield* fs.realPath(temporary);
    const git = (args: Array<string>) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git(["init", "--initial-branch=upstream"]);
    git(["config", "user.name", "Confect test"]);
    git(["config", "user.email", "confect@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "rebase.updateRefs", "true"]);
    yield* fs.writeFileString(`${root}/shared.txt`, "base\n");
    git(["add", "."]);
    git(["commit", "-m", "Release base"]);
    const base = git(["rev-parse", "HEAD"]);
    git(["tag", "@confect/core@10.2.0"]);
    git(["switch", "-c", "fork"]);
    yield* fs.writeFileString(
      `${root}/${conflict ? "shared.txt" : "fork.txt"}`,
      "fork\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "Fork patch"]);
    const forkHead = git(["rev-parse", "HEAD"]);
    git(["switch", "upstream"]);
    yield* fs.writeFileString(`${root}/shared.txt`, "upstream\n");
    git(["add", "."]);
    git(["commit", "-m", "New release"]);
    const target = git(["rev-parse", "HEAD"]);
    git(["tag", "@confect/core@10.3.0"]);
    return { root, git, base, target, forkHead };
  });

test("computes the fork base from git history instead of the fork tip", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, base, target, forkHead } = yield* makeHistory();
      expect(yield* inspectRelease(root, "fork", "upstream")).toEqual({
        _tag: "Rebase",
        tag: "@confect/core@10.3.0",
        base,
        target,
        forkHead,
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test.each([false, true])(
  "checks a real scratch rebase and preserves the fork, conflict=%s",
  (conflict) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, git, target, forkHead } = yield* makeHistory(conflict);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${root}/shared.txt`, "uncommitted work\n");
        yield* fs.writeFileString(`${root}/untracked.txt`, "untracked work\n");
        const result = yield* checkRebase(root, "fork", "upstream").pipe(
          Effect.result,
        );
        if (conflict) {
          expect(Result.isFailure(result) && result.failure).toMatchObject({
            _tag: "RebaseConflict",
            tag: "@confect/core@10.3.0",
            files: ["shared.txt"],
          });
        } else {
          expect(result._tag).toBe("Success");
        }
        expect(git(["rev-parse", "fork"])).toBe(forkHead);
        expect(git(["rev-parse", "HEAD"])).toBe(target);
        expect(yield* fs.readFileString(`${root}/shared.txt`)).toBe(
          "uncommitted work\n",
        );
        expect(yield* fs.readFileString(`${root}/untracked.txt`)).toBe(
          "untracked work\n",
        );
        expect(git(["status", "--porcelain"])).toBe(
          "M shared.txt\n?? untracked.txt",
        );
        expect(git(["branch", "--list", "englever/rebase-check-*"])).toBe("");
        expect(
          git(["worktree", "list", "--porcelain"])
            .split("\n")
            .filter((line) => line.startsWith("worktree ")),
        ).toEqual([`worktree ${root}`]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    ),
);

test("plans the specified release rebase even when the fork base is newer than its tag", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, git, base, target } = yield* makeHistory();
      git(["tag", "-d", "@confect/core@10.3.0"]);
      git(["branch", "-f", "fork", "upstream"]);
      git(["switch", "fork"]);
      git([
        "commit",
        "--allow-empty",
        "-m",
        "Fork after untagged upstream commit",
      ]);
      const forkHead = git(["rev-parse", "fork"]);
      git(["switch", "upstream"]);
      expect(yield* inspectRelease(root, "fork", "upstream")).toEqual({
        _tag: "Rebase",
        tag: "@confect/core@10.2.0",
        target: base,
        base: target,
        forkHead,
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("succeeds on real history already based on the selected tag with fork patches", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, git, forkHead } = yield* makeHistory();
      git(["tag", "-d", "@confect/core@10.3.0"]);
      expect(yield* checkRebase(root, "fork", "upstream")).toMatchObject({
        _tag: "AlreadyCurrent",
        tag: "@confect/core@10.2.0",
      });
      expect(git(["rev-parse", "fork"])).toBe(forkHead);
      expect(
        git(["worktree", "list", "--porcelain"])
          .split("\n")
          .filter((line) => line.startsWith("worktree ")),
      ).toEqual([`worktree ${root}`]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("rebases onto the stable tag while upstream main has a conflicting later commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, git, forkHead } = yield* makeHistory();
      yield* fs.writeFileString(
        `${root}/fork.txt`,
        "upstream main after the release\n",
      );
      git(["add", "."]);
      git(["commit", "-m", "Unreleased conflicting change"]);
      const upstreamHead = git(["rev-parse", "upstream"]);
      expect(yield* checkRebase(root, "fork", "upstream")).toMatchObject({
        _tag: "Rebase",
        tag: "@confect/core@10.3.0",
      });
      expect(git(["rev-parse", "fork"])).toBe(forkHead);
      expect(git(["rev-parse", "upstream"])).toBe(upstreamHead);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));
