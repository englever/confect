import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";

export const make = Effect.fn("RestoreWatcher.make")(function* (
  directory: string,
  onEvent: (event: FileSystem.WatchEvent) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  const parent = yield* Effect.scope;
  const failed = yield* Deferred.make<never, PlatformError.PlatformError>();
  const start = Effect.gen(function* () {
    const scope = yield* Scope.fork(parent, "sequential");
    yield* fs
      .watch(directory, {
        recursive: true,
      })
      .pipe(
        Stream.runForEach(onEvent),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Deferred.failCause(failed, exit.cause)
            : Effect.void,
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
    return scope;
  });
  let scope = yield* start;
  return {
    failure: Deferred.await(failed),
    duringRestore: Effect.acquireRelease(
      Effect.suspend(() => Scope.close(scope, Exit.void)),
      () =>
        start.pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              scope = next;
            }),
          ),
        ),
    ),
  };
});
