import * as Callback from "@confect/core/Callback";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import * as Ref from "@confect/core/Ref";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import { createFunctionHandle } from "convex/server";
import { convexToJson, v, type GenericValidator } from "convex/values";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The host function's compiled validators differ from the contract's on one
 * side. `expected` and `actual` describe the contract's and the host's
 * validators, with union members in a fixed order.
 */
export class CallbackContractMismatch extends Schema.TaggedError<CallbackContractMismatch>()(
  "CallbackContractMismatch",
  {
    contract: Schema.String,
    side: Schema.Literals(["args", "returns", "error"]),
    expected: Schema.Json,
    actual: Schema.Json,
  },
) {
  override get message(): string {
    return `The host function does not satisfy callback contract "${this.contract}": its ${this.side === "error" ? "errors" : this.side} compile to ${JSON.stringify(this.actual)}, the contract's to ${JSON.stringify(this.expected)}.`;
  }
}

const alternatives = (
  validator: GenericValidator,
): ReadonlyArray<GenericValidator> =>
  validator.kind === "union"
    ? validator.members.flatMap(alternatives)
    : [validator];

/**
 * The distinct alternatives `validators` accept, keyed by their description and
 * sorted by it, so union order and repetition do not count as differences.
 */
const membersOf = (
  validators: ReadonlyArray<GenericValidator>,
): ReadonlyArray<readonly [string, Schema.Json]> =>
  pipe(
    validators.flatMap(alternatives),
    Array.map((validator) => {
      const described = describe(validator);
      return [JSON.stringify(described), described] as const;
    }),
    Array.dedupeWith(([a], [b]) => a === b),
    Array.sortWith(([key]) => key, Order.String),
  );

const unionOf = (
  members: ReadonlyArray<readonly [string, Schema.Json]>,
): Schema.Json => {
  const [only, ...rest] = members;
  return only !== undefined && rest.length === 0
    ? only[1]
    : { kind: "union", members: members.map(([, described]) => described) };
};

const describe = (validator: GenericValidator): Schema.Json => {
  switch (validator.kind) {
    case "id":
      return { kind: "id", tableName: validator.tableName };
    case "literal":
      return { kind: "literal", value: convexToJson(validator.value) };
    case "array":
      return { kind: "array", element: describe(validator.element) };
    case "record":
      return {
        kind: "record",
        key: describe(validator.key),
        value: describe(validator.value),
      };
    case "object":
      return {
        kind: "object",
        fields: Object.fromEntries(
          pipe(
            Object.entries(validator.fields),
            Array.sortWith(([name]) => name, Order.String),
            Array.map(([name, field]) => [
              name,
              field.isOptional === "optional"
                ? { kind: "optional", value: describe(field) }
                : describe(field),
            ]),
          ),
        ),
      };
    case "union":
      return unionOf(membersOf([validator]));
    default:
      return { kind: validator.kind };
  }
};

const ownError = (provenance: {
  readonly error?: Schema.Codec<any, any>;
}): ReadonlyArray<Schema.Codec<any, any>> =>
  "error" in provenance && provenance.error !== undefined
    ? [provenance.error]
    : [];

/**
 * Compare the validators Convex would compile for the contract and for the host
 * function, both in the application's ID scope, so a component's IDs are
 * strings on both sides and the host's own IDs stay `v.id`. Args and returns
 * must be equal. Every error the host may fail with, its middleware's included,
 * must be one the contract declares.
 */
const verify = (
  contract: Callback.Any,
  ref: Ref.AnyConfect,
): Result.Result<void, CallbackContractMismatch> => {
  const mismatch = (
    side: CallbackContractMismatch["side"],
    expected: Schema.Json,
    actual: Schema.Json,
  ) =>
    Result.fail(
      new CallbackContractMismatch({
        contract: contract.id,
        side,
        expected,
        actual,
      }),
    );
  const provenance = contract.functionProvenance;

  const expectedArgs = describe(v.object(compileArgsSchema(provenance.args)));
  const actualArgs = describe(v.object(compileArgsSchema(ref.args)));
  if (JSON.stringify(expectedArgs) !== JSON.stringify(actualArgs)) {
    return mismatch("args", expectedArgs, actualArgs);
  }

  const expectedReturns = describe(compileReturnsSchema(provenance.returns));
  const actualReturns = describe(compileReturnsSchema(ref.returns));
  if (JSON.stringify(expectedReturns) !== JSON.stringify(actualReturns)) {
    return mismatch("returns", expectedReturns, actualReturns);
  }

  const expectedErrors = membersOf(
    ownError(provenance).map((schema) => compileReturnsSchema(schema)),
  );
  const actualErrors = membersOf(
    [...ownError(ref), ...MiddlewareSpec.errorSchemas(ref.middlewareSpecs)].map(
      (schema) => compileReturnsSchema(schema),
    ),
  );
  const declared = new Set(expectedErrors.map(([key]) => key));
  if (!actualErrors.every(([key]) => declared.has(key))) {
    return mismatch("error", unionOf(expectedErrors), unionOf(actualErrors));
  }

  return Result.void;
};

/**
 * Create a handle a component can store and run to call `ref` under `contract`.
 * A ref whose function type or wire encoding visibly differs from the contract
 * is a type error. Before asking Convex for the handle, a Confect ref's
 * compiled validators are compared with the contract's, and a difference fails
 * with `CallbackContractMismatch`. A plain Convex ref has no codecs to compile,
 * so only the type check applies to it. A ref to a function that is not
 * deployed is a defect.
 */
export const create = Effect.fn("Callback.create")(function* <
  Contract_ extends Callback.Any,
  Ref_ extends Ref.Any,
>(
  contract: Contract_,
  ref: Ref_ & Callback.Check<Contract_, Ref_>,
): Effect.fn.Return<Callback.Handle<Contract_>, CallbackContractMismatch> {
  if (ref._tag === "Confect") {
    yield* Effect.fromResult(verify(contract, ref));
  }
  const text = yield* Effect.promise(() =>
    createFunctionHandle(Ref.getFunctionReference(ref)),
  );
  return yield* Schema.decodeEffect(Callback.handle(contract))(text).pipe(
    Effect.orDie,
  );
});
