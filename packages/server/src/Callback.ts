import * as Callback from "@confect/core/Callback";
import * as Ref from "@confect/core/Ref";
import { createFunctionHandle } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Create a handle a component can store and run to call `ref` under `contract`.
 * A ref whose function type or wire encoding does not satisfy the contract is a
 * type error. A ref to a function that is not deployed is a defect.
 */
export const create = Effect.fn("Callback.create")(function* <
  Contract_ extends Callback.Any,
  Ref_ extends Ref.Any,
>(
  contract: Contract_,
  ref: Ref_ & Callback.Check<Contract_, Ref_>,
): Effect.fn.Return<Callback.Handle<Contract_>> {
  const text = yield* Effect.promise(() =>
    createFunctionHandle(Ref.getFunctionReference(ref)),
  );
  return yield* Schema.decodeEffect(Callback.handle(contract))(text).pipe(
    Effect.orDie,
  );
});
