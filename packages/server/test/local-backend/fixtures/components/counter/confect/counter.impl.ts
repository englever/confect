import { FunctionImpl, GroupImpl, QueryStream } from "@confect/server";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import schema from "./_generated/schema";
import refs from "./_generated/refs";
import {
  DatabaseReader,
  ExecutionMetadata,
  DatabaseWriter,
  QueryCtx,
  Scheduler,
  StorageReader,
  StorageWriter,
} from "./_generated/services";
import counter, { Rejected } from "./counter.spec";

const create = FunctionImpl.make(schema, counter, "create", (args) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    return yield* writer.table("counters").insert(args);
  }).pipe(Effect.orDie),
);
const list = FunctionImpl.make(schema, counter, "list", ({ run }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return yield* reader
      .table("counters")
      .index("by_run", (range) => range.eq("run", run))
      .collect();
  }).pipe(Effect.orDie),
);
const reject = FunctionImpl.make(schema, counter, "reject", ({ run }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const id = yield* writer
      .table("counters")
      .insert({ run, count: 999 })
      .pipe(Effect.orDie);
    return yield* new Rejected({ id, run });
  }),
);
const schedule = FunctionImpl.make(schema, counter, "schedule", (args) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    return yield* scheduler.runAfter(
      Duration.zero,
      refs.public.counter.create,
      args,
    );
  }),
);
const uploadUrl = FunctionImpl.make(schema, counter, "uploadUrl", () =>
  Effect.gen(function* () {
    const storage = yield* StorageWriter;
    return (yield* storage.generateUploadUrl).toString();
  }),
);
const storageUrl = FunctionImpl.make(schema, counter, "storageUrl", ({ id }) =>
  Effect.gen(function* () {
    const storage = yield* StorageReader;
    return (yield* storage.getUrl(id)).toString();
  }).pipe(Effect.orDie),
);
const hasAuth = FunctionImpl.make(schema, counter, "hasAuth", () =>
  Effect.map(QueryCtx, (ctx) => Predicate.hasProperty(ctx, "auth")),
);

const location = FunctionImpl.make(schema, counter, "location", () =>
  Effect.gen(function* () {
    const execution = yield* ExecutionMetadata;
    return (yield* execution.getFunction()).componentPath;
  }),
);
const page = FunctionImpl.make(
  schema,
  counter,
  "page",
  ({ run, cursor, numItems }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      return yield* QueryStream.paginate(
        reader
          .table("counters")
          .stream("by_run_count", (range) => range.eq("run", run)),
        { cursor, numItems },
      );
    }).pipe(Effect.orDie),
);
const environment = FunctionImpl.make(schema, counter, "environment", () =>
  Effect.gen(function* () {
    const required = yield* Config.String("COMPONENT_REQUIRED");
    const optional = yield* Config.String("COMPONENT_OPTIONAL").pipe(
      Config.withDefault("unset"),
    );
    const marker = yield* Config.String("COMPONENT_MARKER").pipe(
      Config.withDefault("unset"),
    );
    const unbound = yield* Config.String("COMPONENT_UNBOUND").pipe(
      Config.withDefault("unset"),
    );
    const hostOnly = yield* Config.String("COMPONENT_HOST_ONLY").pipe(
      Config.withDefault("unset"),
    );
    return {
      required,
      optional,
      marker,
      unbound,
      hostOnly,
      // Compare native reads with Config at the actual component boundary.
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- Compare direct native reads with Config for this installation.
      directRequired: process.env.COMPONENT_REQUIRED ?? "unset",
    };
  }).pipe(Effect.orDie),
);
const tick = FunctionImpl.make(schema, counter, "tick", () =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* writer.table("counters").insert({ run: "cron", count: 1 });
    return null;
  }).pipe(Effect.orDie),
);
const ticks = FunctionImpl.make(schema, counter, "ticks", () =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return (yield* reader
      .table("counters")
      .index("by_run", (range) => range.eq("run", "cron"))
      .collect()).length;
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, counter).pipe(
  Layer.provide([
    create,
    list,
    reject,
    schedule,
    uploadUrl,
    storageUrl,
    hasAuth,
    location,
    page,
    environment,
    tick,
    ticks,
  ]),
  GroupImpl.finalize,
);
