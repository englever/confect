import {
  Callback as CoreCallback,
  FunctionSpec,
  GenericId,
  GroupSpec,
  IdScope,
  MiddlewareSpec,
  Ref,
  Refs,
  Spec,
} from "@confect/core";
import type * as RuntimeAndFunctionType from "@confect/core/RuntimeAndFunctionType";
import * as Callback from "@confect/server/Callback";
import { makeFunctionReference } from "convex/server";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

class EventRejected extends Schema.TaggedError<EventRejected>()(
  "EventRejected",
  { reason: Schema.String },
) {}

class Unrelated extends Schema.TaggedError<Unrelated>()("Unrelated", {
  reason: Schema.String,
}) {}

const Status = Schema.Literals(["queued", "sent", "bounced"]);

const OnEvent = CoreCallback.mutation("counter/onEvent", {
  args: () => ({ run: Schema.String, status: Status }),
  returns: () => Schema.Null,
  error: () => EventRejected,
});

const host = <Spec extends FunctionSpec.AnyWithProps>(spec: Spec) =>
  Ref.make("callbacks", spec);

const onEvent = Ref.make(
  "callbacks",
  FunctionSpec.internalMutation({
    name: "onEvent",
    args: () => ({ run: Schema.String, status: Status }),
    returns: () => Schema.Null,
    error: () => EventRejected,
  }),
);

describe("create", () => {
  it.effect(
    "asks Convex for a handle to the ref and runs the component's calls through it",
    () =>
      Effect.gen(function* () {
        const syscalls: Array<[string, unknown]> = [];
        vi.stubGlobal("Convex", {
          asyncSyscall: (op: string, arg: string) => {
            syscalls.push([op, JSON.parse(arg)]);
            return Promise.resolve(
              JSON.stringify("function://;callbacks:onEvent"),
            );
          },
        });
        const handle = yield* Callback.create(OnEvent, onEvent).pipe(
          Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
        );
        expect(syscalls).toEqual([
          [
            "1.0/createFunctionHandle",
            expect.objectContaining({ name: "callbacks:onEvent" }),
          ],
        ]);
        const calls: Array<unknown> = [];
        yield* Ref.runWithCodec(
          handle,
          { run: "a", status: "sent" },
          (functionReference, encodedArgs) => {
            calls.push(functionReference, encodedArgs);
            return Promise.resolve(null);
          },
        );
        expect(calls).toEqual([
          "function://;callbacks:onEvent",
          { run: "a", status: "sent" },
        ]);
      }),
  );
});

describe("create types", () => {
  const publicRef = Ref.make(
    "callbacks",
    FunctionSpec.publicMutation({
      name: "onEventPublic",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const wrongArgs = host(
    FunctionSpec.internalMutation({
      name: "wrongArgs",
      args: () => ({ run: Schema.Finite, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const missingArg = host(
    FunctionSpec.internalMutation({
      name: "missingArg",
      args: () => ({ run: Schema.String }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const aQuery = Ref.make(
    "callbacks",
    FunctionSpec.internalQuery({
      name: "aQuery",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
    }),
  );
  const undeclaredError = host(
    FunctionSpec.internalMutation({
      name: "undeclaredError",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => Unrelated,
    }),
  );
  const noError = host(
    FunctionSpec.internalMutation({
      name: "noError",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
    }),
  );
  const wideArgs = host(
    FunctionSpec.internalMutation({
      name: "wideArgs",
      args: () => ({
        run: Schema.String,
        status: Schema.String,
        note: Schema.optionalKey(Schema.String),
      }),
      returns: () => Schema.Null,
    }),
  );

  it("accepts a matching internal or public ref", () => {
    type Created = Effect.Effect<CoreCallback.Handle<typeof OnEvent>>;
    expectTypeOf(Callback.create(OnEvent, onEvent)).toEqualTypeOf<Created>();
    expectTypeOf(Callback.create(OnEvent, publicRef)).toEqualTypeOf<Created>();
    expectTypeOf(Callback.create(OnEvent, noError)).toEqualTypeOf<Created>();
  });

  it("N1: rejects a ref whose args do not match the contract", () => {
    // @ts-expect-error N1 run is a number on the host, a string in the contract
    void Callback.create(OnEvent, wrongArgs);
    // @ts-expect-error N1 the host would reject the status field the component sends
    void Callback.create(OnEvent, missingArg);
    // @ts-expect-error N1 the host declares wider args than the contract sends
    void Callback.create(OnEvent, wideArgs);
  });

  it("N2: rejects a query where the contract needs a mutation", () => {
    // @ts-expect-error N2 the contract needs a mutation
    void Callback.create(OnEvent, aQuery);
  });

  it("rejects a ref that fails with errors the contract does not declare", () => {
    // @ts-expect-error the host may fail with Unrelated, which the component cannot decode
    void Callback.create(OnEvent, undeclaredError);
  });

  it("H1: rejects a ref whose returns or errors are encoded differently", () => {
    const Counted = CoreCallback.mutation("counter/onCounted", {
      args: () => ({ run: Schema.String }),
      returns: () => Schema.FiniteFromString,
    });
    const finiteOnWire = host(
      FunctionSpec.internalMutation({
        name: "finiteOnWire",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.Finite,
      }),
    );
    const finiteFromString = host(
      FunctionSpec.internalMutation({
        name: "finiteFromString",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.FiniteFromString,
      }),
    );
    void Callback.create(Counted, finiteFromString);
    // @ts-expect-error H1 the host returns a number on the wire, the contract decodes a string
    void Callback.create(Counted, finiteOnWire);

    class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<RejectedOnWire>()(
      "Rejected",
      { at: Schema.Finite },
    ) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const rejectsOnWire = host(
      FunctionSpec.internalMutation({
        name: "rejectsOnWire",
        returns: () => Schema.Null,
        error: () => RejectedOnWire,
      }),
    );
    // @ts-expect-error H1 the host encodes its error's field as a number, the contract decodes a string
    void Callback.create(Guarded, rejectsOnWire);
  });

  it("N1: rejects a ref that would refuse a nested field the contract sends", () => {
    const Nested = CoreCallback.mutation("counter/onNested", {
      args: () => ({
        payload: Schema.Struct({ run: Schema.String, status: Status }),
        history: Schema.Array(Schema.Struct({ status: Status })),
      }),
      returns: () => Schema.Null,
    });
    const nestedMatch = host(
      FunctionSpec.internalMutation({
        name: "nestedMatch",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String, status: Status }),
          history: Schema.Array(Schema.Struct({ status: Status })),
        }),
        returns: () => Schema.Null,
      }),
    );
    const nestedObject = host(
      FunctionSpec.internalMutation({
        name: "nestedObject",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String }),
          history: Schema.Array(Schema.Struct({ status: Status })),
        }),
        returns: () => Schema.Null,
      }),
    );
    const nestedArray = host(
      FunctionSpec.internalMutation({
        name: "nestedArray",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String, status: Status }),
          history: Schema.Array(Schema.Struct({})),
        }),
        returns: () => Schema.Null,
      }),
    );
    void Callback.create(Nested, nestedMatch);
    // @ts-expect-error N1 the host's validator would reject payload.status
    void Callback.create(Nested, nestedObject);
    // @ts-expect-error N1 the host's validator would reject history[].status
    void Callback.create(Nested, nestedArray);
  });

  it("H1: rejects a ref whose middleware encodes an error differently", () => {
    class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<RejectedOnWire>()(
      "Rejected",
      { at: Schema.Finite },
    ) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => RejectedOnWire,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const refs = Refs.make(
      Spec.make().add(
        GroupSpec.makeAt("gated")
          .middleware(Gate)
          .addFunction(
            FunctionSpec.internalMutation({
              name: "onGuarded",
              returns: () => Schema.Null,
            }),
          ),
      ),
    );
    // @ts-expect-error H1 the host's middleware encodes Rejected.at as a number
    void Callback.create(Guarded, refs.internal.gated.onGuarded);
  });

  it("N1: rejects a host whose union args would refuse what the contract sends", () => {
    const Tagged = CoreCallback.mutation("counter/onTagged", {
      args: () => ({
        event: Schema.Struct({
          kind: Schema.Literal("a"),
          a: Schema.String,
          b: Schema.String,
        }),
      }),
      returns: () => Schema.Null,
    });
    const split = host(
      FunctionSpec.internalMutation({
        name: "split",
        args: () => ({
          event: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("b"), b: Schema.String }),
          ]),
        }),
        returns: () => Schema.Null,
      }),
    );
    // @ts-expect-error N1 neither branch of the host's union accepts a and b together
    void Callback.create(Tagged, split);
  });

  it("accepts a host that types a component's ID with its own scope", () => {
    const definition = IdScope.component("counter");
    const installation = IdScope.instance(IdScope.app, "first");
    const Scoped = CoreCallback.mutation("counter/onScoped", {
      args: () => ({ id: GenericId.GenericId("deliveries", definition) }),
      returns: () => Schema.Null,
    });
    const scoped = host(
      FunctionSpec.internalMutation({
        name: "scoped",
        args: () => ({ id: GenericId.GenericId("deliveries", installation) }),
        returns: () => Schema.Null,
      }),
    );
    expectTypeOf(Callback.create(Scoped, scoped)).toEqualTypeOf<
      Effect.Effect<CoreCallback.Handle<typeof Scoped>>
    >();
  });

  it("H1: rejects a ref built directly whose function middleware encodes an error differently", () => {
    class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<RejectedOnWire>()(
      "Rejected",
      { at: Schema.Finite },
    ) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => RejectedOnWire,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const gated = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "gated",
        returns: () => Schema.Null,
      }).middleware(Gate),
    );
    // @ts-expect-error H1 the function's own middleware encodes Rejected.at as a number
    void Callback.create(Guarded, gated);
  });

  it("rejects a parameter that may hold a ref with erased codecs", () => {
    const forward = (
      ref: Ref.Ref<
        RuntimeAndFunctionType.ConvexMutation,
        "internal",
        CoreCallback.Args<typeof OnEvent>,
        null,
        EventRejected
      >,
    ) =>
      // @ts-expect-error a Ref.Ref may be a Confect ref with erased codecs
      Callback.create(OnEvent, ref);
    void forward;
  });

  it("N1: rejects a host that omits an optional field the contract may send", () => {
    const Noted = CoreCallback.mutation("counter/onNoted", {
      args: () => ({
        run: Schema.String,
        note: Schema.optionalKey(Schema.String),
      }),
      returns: () => Schema.Null,
    });
    const unnoted = host(
      FunctionSpec.internalMutation({
        name: "unnoted",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.Null,
      }),
    );
    const noted = host(
      FunctionSpec.internalMutation({
        name: "noted",
        args: () => ({
          run: Schema.String,
          note: Schema.optional(Schema.String),
        }),
        returns: () => Schema.Null,
      }),
    );
    void Callback.create(Noted, noted);
    // @ts-expect-error N1 the host's validator would reject note when it is sent
    void Callback.create(Noted, unnoted);
  });

  it("N1: rejects a host whose args are narrower than an unknown arg", () => {
    const Opaque = CoreCallback.mutation("counter/onOpaque", {
      args: () => ({ payload: Schema.Unknown }),
      returns: () => Schema.Null,
    });
    const empty = host(
      FunctionSpec.internalMutation({
        name: "empty",
        args: () => ({ payload: Schema.Struct({}) }),
        returns: () => Schema.Null,
      }),
    );
    // @ts-expect-error N1 the component may send any value as payload
    void Callback.create(Opaque, empty);
  });

  it("accepts a plain Convex ref with the same wire args", () => {
    const Tagged = CoreCallback.mutation("counter/onTags", {
      args: () => ({ tags: Schema.Array(Schema.String) }),
      returns: () => Schema.Null,
    });
    const native = Ref.fromFunctionReference(
      makeFunctionReference<"mutation", { tags: string[] }, null>(
        "callbacks:tags",
      ),
    );
    expectTypeOf(Callback.create(Tagged, native)).toEqualTypeOf<
      Effect.Effect<CoreCallback.Handle<typeof Tagged>>
    >();
  });

  it("H1: rejects a ref built with group middleware whose errors the contract does not declare", () => {
    class Blocked extends Schema.TaggedError<Blocked>()("Blocked", {}) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => Blocked,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Quiet = CoreCallback.mutation("counter/onQuiet", {
      returns: () => Schema.Null,
    });
    const grouped = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "grouped",
        returns: () => Schema.Null,
      }),
      [{ spec: Gate, options: undefined }],
    );
    // @ts-expect-error H1 the group's middleware may fail with Blocked
    void Callback.create(Quiet, grouped);
  });

  it("rejects a ref whose codecs are erased", () => {
    const erased: Ref.Ref<
      RuntimeAndFunctionType.ConvexMutation,
      "internal",
      CoreCallback.Args<typeof OnEvent>,
      null,
      EventRejected
    > = onEvent;
    // @ts-expect-error a ref typed from values alone cannot prove its encoding
    void Callback.create(OnEvent, erased);
  });

  it("N3: a component arg typed with one contract refuses another contract's handle", () => {
    const Other = CoreCallback.mutation("other/onEvent", {
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    });
    const send = Ref.make(
      "deliveries",
      FunctionSpec.publicMutation({
        name: "send",
        args: () => ({
          run: Schema.String,
          onEvent: CoreCallback.handle(OnEvent),
        }),
        returns: () => Schema.Null,
      }),
    );
    const sendArgs = (
      own: CoreCallback.Handle<typeof OnEvent>,
      other: CoreCallback.Handle<typeof Other>,
    ) => {
      const ok: Ref.Args<typeof send> = { run: "a", onEvent: own };
      // @ts-expect-error N3 a handle for "other/onEvent" is not one for "counter/onEvent"
      const wrong: Ref.Args<typeof send> = { run: "a", onEvent: other };
      return [ok, wrong];
    };
    void sendArgs;
  });

  it("forwards a caller's ref through explicit type arguments", () => {
    const send = <R extends Ref.Any>(
      ref: R & CoreCallback.Check<typeof OnEvent, R>,
    ) => Callback.create<typeof OnEvent, R>(OnEvent, ref);
    void send(onEvent);
    // @ts-expect-error the caller's ref is checked at the caller's call site
    void send(aQuery);
  });
});
