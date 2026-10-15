---
"@confect/core": minor
"@confect/server": minor
---

Add typed callbacks for components. A component declares a contract with `Callback.mutation`, `Callback.query`, or `Callback.action`, stores the host's handle using the `Callback.handle(contract)` schema, and runs it with `MutationRunner`, `QueryRunner`, `ActionRunner`, or `Scheduler`. Declared errors arrive by tag. A host creates the handle with `Callback.create` from `@confect/server`. Passing a function whose type, args, returns, or errors do not match the contract on the wire is a type error.

In the component:

```ts
import { Callback } from "@confect/core";

export const OnEvent = Callback.mutation("email/onEvent", {
  args: () => ({ emailId: Schema.String, status: Status }),
  returns: () => Schema.Null,
  error: () => EventRejected,
});

// a table field (or function arg) that holds the handle
Schema.Struct({ to: Schema.String, onEvent: Callback.handle(OnEvent) });

// run the stored handle
Effect.gen(function* () {
  const runner = yield* MutationRunner;
  yield* runner
    .runMutation(email.onEvent, { emailId, status: "bounced" })
    .pipe(
      Effect.catchTag("EventRejected", (rejected) =>
        Effect.log(rejected.reason),
      ),
    );
});
```

In the host:

```ts
import { Callback } from "@confect/server";

Effect.gen(function* () {
  const runner = yield* MutationRunner;
  const onEvent = yield* Callback.create(OnEvent, refs.internal.emails.onEvent);
  yield* runner.runMutation(email.email.send, { to, onEvent });
});
```

`Ref.ConfectRef` and generated references now keep the returns and error codecs their functions declare, so `ref.returns` and `ref.error` have the declared codec types, `Ref.ReturnsSchema` and `Ref.ErrorSchema` read them, and `Ref.EncodedError` gives the wire form of every error a reference can fail with, middleware included. Two references whose returns decode to the same type but are encoded differently are no longer assignable to each other.
