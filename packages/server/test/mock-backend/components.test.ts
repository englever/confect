/// <reference types="vite/client" />

import * as componentTesting from "./fixtures/componentTesting";
import * as mounts from "../local-backend/fixtures/confect/componentBindings";
import counterConvexSchema from "../local-backend/fixtures/components/counter/convex/schema";
import innerConvexSchema from "../local-backend/fixtures/components/inner/convex/schema";
import middleConvexSchema from "../local-backend/fixtures/components/middle/convex/schema";
import parentConvexSchema from "../local-backend/fixtures/components/parent/convex/schema";
import { Rejected as CounterRejected } from "../local-backend/fixtures/components/counter/confect/counter.spec";
import type { Ref } from "@confect/core";
import { Component } from "@confect/core";
import {
  DatabaseSchema,
  MutationRunner,
  QueryRunner,
  RegisteredConvexFunction,
} from "@confect/server";
// Keep the server/test workspace dependency graph acyclic, as in mock-backend/TestConfect.ts.
import { TestConfect } from "../../../test/src";
import { expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  defineSchema,
  type FunctionReference,
} from "convex/server";
import * as Effect from "effect/Effect";
import * as Array from "effect/Array";
import * as Result from "effect/Result";
import contract from "../../../cli/test/fixtures/authored-component/confect/_generated/component";
import componentSchema from "../../../cli/test/fixtures/authored-component/convex/schema";

// The wire API shape Convex generates: component IDs are strings, not host IDs.
type CounterApi<ComponentName extends string> = {
  counter: {
    create: FunctionReference<
      "mutation",
      "internal",
      { count: string },
      string,
      ComponentName
    >;
    list: FunctionReference<
      "query",
      "internal",
      {},
      Array<{ _id: string; _creationTime: number; count: string }>,
      ComponentName
    >;
    reject: FunctionReference<"mutation", "internal", {}, null, ComponentName>;
  };
};
const components = componentsGeneric() as unknown as {
  first: CounterApi<"first">;
  second: CounterApi<"second">;
};
const first = Component.bind(contract, components.first);
const second = Component.bind(contract, components.second);
const hostSchema = DatabaseSchema.make({});
const hostConvexSchema = defineSchema({});
const hostModules = { "_generated/server.ts": () => Promise.resolve({}) };
const componentModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "counter.ts": () =>
    import("../../../cli/test/fixtures/authored-component/convex/counter"),
};

it.effect(
  "runs a generated component through vanilla Convex and scoped Confect runners",
  () =>
    Effect.gen(function* () {
      const t = convexTest(hostConvexSchema, hostModules);
      t.registerComponent("first", componentSchema, componentModules);
      t.registerComponent("second", componentSchema, componentModules);
      const wireId = yield* Effect.promise(() =>
        t.mutation(components.first.counter.create, { count: "2" }),
      );
      const wireDocs = yield* Effect.promise(() =>
        t.query(components.first.counter.list),
      );
      expect(wireDocs).toEqual([
        { _id: wireId, _creationTime: expect.any(Number), count: "2" },
      ]);

      const result = yield* Effect.promise(() =>
        t.run((ctx) =>
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- Convex invokes this callback in its transaction context; the handler needs its own per-call services.
          Effect.runPromise(
            Effect.gen(function* () {
              const mutation = yield* MutationRunner.MutationRunner;
              const query = yield* QueryRunner.QueryRunner;
              const id = yield* mutation.runMutation(second.counter.create, {
                count: 7,
              });
              const failure = yield* Effect.result(
                mutation.runMutation(first.counter.reject),
              );
              expect(Result.isFailure(failure)).toBe(true);
              if (Result.isFailure(failure))
                expect(failure.failure).toMatchObject({
                  _tag: "Rejected",
                  id: expect.any(String),
                });
              // Catching a typed component error must not commit its failed subtransaction.
              return {
                id,
                first: yield* query.runQuery(first.counter.list),
                second: yield* query.runQuery(second.counter.list),
              };
            }).pipe(
              Effect.provide(
                RegisteredConvexFunction.mutationLayer(hostSchema, ctx),
              ),
            ),
          ),
        ),
      );
      expect(Array.map(result.first, (row) => row.count)).toEqual([2]);
      expect(result.second).toEqual([
        { _id: result.id, _creationTime: expect.any(Number), count: 7 },
      ]);
      const own: Ref.Returns<typeof second.counter.create> = result.id;
      // @ts-expect-error Component installations have different ID types.
      const wrong: Ref.Returns<typeof first.counter.create> = result.id;
      void [own, wrong];
    }),
);

it.effect("registers components with TestConfect", () =>
  Effect.gen(function* () {
    const t = yield* TestConfect.TestConfect<typeof hostSchema>();
    yield* t.registerComponent("first", componentSchema, componentModules);
    yield* t.mutation(first.counter.create, { count: 11 });
    expect(
      Array.map(yield* t.query(first.counter.list), (row) => row.count),
    ).toEqual([11]);
  }).pipe(
    Effect.provide(
      TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
    ),
  ),
);

const counterModules = import.meta.glob([
  "../local-backend/fixtures/components/counter/convex/**/*.ts",
  "!../local-backend/fixtures/components/counter/convex/**/*.*.*",
]);
const innerModules = import.meta.glob([
  "../local-backend/fixtures/components/inner/convex/**/*.ts",
  "!../local-backend/fixtures/components/inner/convex/**/*.*.*",
]);
const middleModules = import.meta.glob([
  "../local-backend/fixtures/components/middle/convex/**/*.ts",
  "!../local-backend/fixtures/components/middle/convex/**/*.*.*",
]);
const parentModules = import.meta.glob([
  "../local-backend/fixtures/components/parent/convex/**/*.ts",
  "!../local-backend/fixtures/components/parent/convex/**/*.*.*",
]);

const registerGraph = Effect.gen(function* () {
  const t = yield* TestConfect.TestConfect<typeof hostSchema>();
  yield* t.registerComponent("first", counterConvexSchema, counterModules);
  yield* t.registerComponent("second", counterConvexSchema, counterModules);
  for (const mount of ["left", "right"]) {
    yield* t.registerComponent(mount, parentConvexSchema, parentModules);
    yield* t.registerComponent(
      `${mount}/child`,
      counterConvexSchema,
      counterModules,
    );
    yield* t.registerComponent(
      `${mount}/deep`,
      middleConvexSchema,
      middleModules,
    );
    yield* t.registerComponent(
      `${mount}/deep/child`,
      innerConvexSchema,
      innerModules,
    );
    yield* t.registerComponent(
      `${mount}/deep/child/child`,
      counterConvexSchema,
      counterModules,
    );
  }
  return t;
});

it.effect(
  "isolates two installations through three nested child bindings",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      yield* t.mutation(mounts.left.parent.deepCreate, {
        run: "nested",
        count: 23,
      });
      yield* t.mutation(mounts.right.parent.deepCreate, {
        run: "nested",
        count: 29,
      });
      const leftRows = yield* t.query(mounts.left.parent.deepList, {
        run: "nested",
      });
      const rightRows = yield* t.query(mounts.right.parent.deepList, {
        run: "nested",
      });
      expect(leftRows).toEqual([23]);
      expect(rightRows).toEqual([29]);
      expect(yield* t.query(mounts.left.parent.deepLocation)).toBe(
        "left/deep/child/child",
      );
      expect(yield* t.query(mounts.right.parent.deepLocation)).toBe(
        "right/deep/child/child",
      );
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "decodes a declared tagged class and rolls back only the failed component call",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      yield* t.mutation(mounts.first.counter.create, {
        run: "rollback",
        count: 5,
      });
      const failure = yield* Effect.result(
        t.mutation(mounts.first.counter.reject, { run: "rollback" }),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure).toBeInstanceOf(CounterRejected);
        expect(failure.failure).toMatchObject({
          _tag: "Rejected",
          run: "rollback",
          id: expect.any(String),
        });
      }
      expect(
        (yield* t.query(mounts.first.counter.list, { run: "rollback" })).map(
          (row) => row.count,
        ),
      ).toEqual([5]);
      expect(
        yield* t.query(mounts.second.counter.list, { run: "rollback" }),
      ).toEqual([]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "paginates a component QueryStream across three pages in its own installation",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      for (const count of [1, 2, 3, 4, 5])
        yield* t.mutation(mounts.first.counter.create, { run: "pages", count });
      yield* t.mutation(mounts.second.counter.create, {
        run: "pages",
        count: 99,
      });
      const firstPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: null,
        numItems: 2,
      });
      const secondPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: firstPage.continueCursor,
        numItems: 2,
      });
      const lastPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: secondPage.continueCursor,
        numItems: 2,
      });
      expect(
        [firstPage, secondPage, lastPage].map((page) =>
          page.page.map((doc) => doc.count),
        ),
      ).toEqual([[1, 2], [3, 4], [5]]);
      expect([firstPage.isDone, secondPage.isDone, lastPage.isDone]).toEqual([
        false,
        false,
        true,
      ]);
      expect(
        (yield* t.query(mounts.second.counter.list, { run: "pages" })).map(
          (row) => row.count,
        ),
      ).toEqual([99]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "registers a component kit before the TestConfect layer resolves",
  () =>
    Effect.gen(function* () {
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      yield* t.mutation(first.counter.create, { count: 17 });
      expect(
        Array.map(yield* t.query(first.counter.list), (row) => row.count),
      ).toEqual([17]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
          register: (registerComponent) =>
            componentTesting.register(registerComponent, "first"),
        }),
      ),
    ),
);
