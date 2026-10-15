import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class NoStableCoreRelease extends Schema.TaggedError<NoStableCoreRelease>()(
  "NoStableCoreRelease",
  { tags: Schema.Array(Schema.String) },
) {}

export const selectReleaseTag = (
  tags: ReadonlyArray<string>,
): Result.Result<string, NoStableCoreRelease> => {
  const releases = tags
    .filter((tag) =>
      /^@confect\/core@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
        tag,
      ),
    )
    .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  return releases[0] === undefined
    ? Result.fail(new NoStableCoreRelease({ tags }))
    : Result.succeed(releases[0]);
};

interface ReleaseHistory {
  readonly tag: string;
  readonly target: string;
  readonly base: string;
  readonly forkHead: string;
}

export const planRebase = (
  history: ReleaseHistory,
): ReleaseHistory & { readonly _tag: "AlreadyCurrent" | "Rebase" } => ({
  ...history,
  _tag: history.base === history.target ? "AlreadyCurrent" : "Rebase",
});

class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()(
  "GitCommandFailed",
  {
    args: Schema.Array(Schema.String),
    directory: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

class RebaseFailed extends Schema.TaggedError<RebaseFailed>()("RebaseFailed", {
  tag: Schema.String,
  base: Schema.String,
  output: Schema.String,
}) {}

class RebaseConflict extends Schema.TaggedError<RebaseConflict>()(
  "RebaseConflict",
  {
    tag: Schema.String,
    base: Schema.String,
    files: Schema.Array(Schema.String),
    output: Schema.String,
  },
) {}

const gitResult = Effect.fn("RebaseRelease.commandResult")(function* (
  args: Array<string>,
  directory: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", args, {
      cwd: directory,
      stdin: "ignore",
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
      },
      extendEnv: true,
    }),
  );
  return yield* Effect.all(
    {
      exitCode: handle.exitCode,
      stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

const git = Effect.fn("RebaseRelease.git")(function* (
  args: Array<string>,
  directory: string,
) {
  const result = yield* gitResult(args, directory);
  if (result.exitCode !== 0)
    return yield* new GitCommandFailed({
      args,
      directory,
      exitCode: result.exitCode,
      output: result.stdout + result.stderr,
    });
  return result.stdout.trim();
});

export const inspectRelease = Effect.fn("RebaseRelease.inspect")(function* (
  directory: string,
  forkRef: string,
  upstreamRef: string,
) {
  const tags = (yield* git(
    ["tag", "--list", "@confect/core@*"],
    directory,
  )).split("\n");
  const tag = yield* Effect.fromResult(selectReleaseTag(tags));
  const forkHead = yield* git(["rev-parse", `${forkRef}^{commit}`], directory);
  const target = yield* git(["rev-parse", `${tag}^{commit}`], directory);
  const base = yield* git(["merge-base", forkRef, upstreamRef], directory);
  return planRebase({ tag, target, base, forkHead });
});

export const checkRebase = Effect.fn("RebaseRelease.check")(function* (
  directory: string,
  forkRef: string,
  upstreamRef: string,
) {
  const plan = yield* inspectRelease(directory, forkRef, upstreamRef);
  if (plan._tag === "AlreadyCurrent") {
    yield* Console.log(`Already current at ${plan.tag} (${plan.base})`);
    return plan;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-rebase-",
  });
  const scratch = path.join(temporary, "checkout");
  const branch = `englever/rebase-check-${path.basename(temporary)}`;
  yield* Effect.acquireRelease(
    git(["worktree", "add", "-b", branch, scratch, plan.forkHead], directory),
    () =>
      Effect.gen(function* () {
        yield* git(["rebase", "--abort"], scratch).pipe(Effect.ignore);
        yield* git(["worktree", "remove", "--force", scratch], directory);
        yield* git(["branch", "-D", branch], directory);
      }).pipe(Effect.orDie),
  );
  const result = yield* gitResult(
    [
      "-c",
      "user.name=Confect rebase check",
      "-c",
      "user.email=confect@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "rebase.updateRefs=false",
      "rebase",
      "--onto",
      plan.tag,
      plan.base,
    ],
    scratch,
  );
  if (result.exitCode !== 0) {
    const files = (yield* git(
      ["diff", "--name-only", "--diff-filter=U"],
      scratch,
    ))
      .split("\n")
      .filter(Boolean);
    yield* Console.error(
      `Rebase onto ${plan.tag} failed. Conflicting files:\n${files.join("\n") || "(none; see git output)"}`,
    );
    if (files.length === 0)
      return yield* new RebaseFailed({
        tag: plan.tag,
        base: plan.base,
        output: result.stdout + result.stderr,
      });
    return yield* new RebaseConflict({
      tag: plan.tag,
      base: plan.base,
      files,
      output: result.stdout + result.stderr,
    });
  }
  yield* Console.log(
    `Rebase applies cleanly onto ${plan.tag}; fork ref remains ${plan.forkHead}`,
  );
  return plan;
}, Effect.scoped);

if (import.meta.main) {
  const [forkRef = "origin/englever/main", upstreamRef = "upstream/main"] =
    Bun.argv.slice(2);
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* checkRebase(
      path.resolve(import.meta.dir, ".."),
      forkRef,
      upstreamRef,
    );
  }).pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
