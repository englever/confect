---
"@confect/core": minor
"@confect/server": minor
---

Add typed callbacks for components. A component declares a contract with `Callback.mutation`, `Callback.query`, or `Callback.action`, stores the host's handle using the `Callback.handle(contract)` schema, and runs it with `MutationRunner`, `QueryRunner`, `ActionRunner`, or `Scheduler`. Declared errors arrive by tag. A host creates the handle with `Callback.create` from `@confect/server`. Passing a function whose type, args, returns, or errors visibly differ from the contract on the wire is a type error, and before it creates the handle `Callback.create` compares the validators Convex compiles for the function and the contract.

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

When the validators differ, `Callback.create` fails with a `CallbackContractMismatch` whose message names the side and both validators, for example:

```text
The host function does not satisfy callback contract "email/onEvent": its args compile to {"kind":"object","fields":{"state":{"kind":"string"}}}, the contract's to {"kind":"object","fields":{"status":{"kind":"string"}}}.
```

Args and returns must compile to the same validators, and every error the function may fail with, its middleware's included, must compile to one the contract declares. A plain Convex reference has no codecs to compile and is checked by its types only. Codecs that compile to the same validator, such as `Schema.DateFromString` and `Schema.DurationFromString` or two schemas that differ only in a refinement, are not told apart.

Generated references now carry the returns and error codecs their functions declare, so two references whose return or error schemas differ are no longer assignable to each other, even when both encode and decode the same types. References built directly from a function spec now include the errors of the function's middleware, as generated references already did.
