import * as Callback from "@confect/core/Callback";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import * as Ref from "@confect/core/Ref";
import {
  compileArgsSchema,
  compileAst,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import { createFunctionHandle } from "convex/server";
import { convexToJson, v, type GenericValidator } from "convex/values";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

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

const literalKinds: Record<string, string> = {
  string: "string",
  number: "float64",
  bigint: "int64",
  boolean: "boolean",
};

/**
 * The alternatives `validators` accept, without those another alternative
 * already covers: everything under `v.any()`, and a literal under its base
 * kind. `true` and `false` together are `v.boolean()`.
 */
const alternativesOf = (
  validators: ReadonlyArray<GenericValidator>,
): ReadonlyArray<GenericValidator> => {
  const flat = validators.flatMap(alternatives);
  if (flat.some(({ kind }) => kind === "any")) {
    return [v.any()];
  }
  const booleans = new Set(
    flat.flatMap((validator) =>
      validator.kind === "literal" && typeof validator.value === "boolean"
        ? [validator.value]
        : [],
    ),
  );
  const widened =
    booleans.has(true) && booleans.has(false) ? [...flat, v.boolean()] : flat;
  const kinds = new Set<string>(widened.map(({ kind }) => kind));
  return widened.filter(
    (validator) =>
      validator.kind !== "literal" ||
      !kinds.has(literalKinds[typeof validator.value] ?? ""),
  );
};

const keyed = (
  described: ReadonlyArray<Schema.Json>,
): ReadonlyArray<readonly [string, Schema.Json]> =>
  pipe(
    described,
    Array.map((json) => [JSON.stringify(json), json] as const),
    Array.dedupeWith(([a], [b]) => a === b),
    Array.sortWith(([key]) => key, Order.String),
  );

/**
 * The distinct alternatives `validators` accept, keyed by their description and
 * sorted by it, so union order and repetition do not count as differences.
 */
const membersOf = (validators: ReadonlyArray<GenericValidator>) =>
  keyed(alternativesOf(validators).map(describe));

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

const errorAlternatives = (schema: Schema.Top): ReadonlyArray<Schema.Top> =>
  SchemaAST.isUnion(schema.ast) &&
  Predicate.hasProperty(schema, "members") &&
  Array.isArray(schema.members)
    ? schema.members.flatMap((member) =>
        Schema.isSchema(member) ? errorAlternatives(member) : [],
      )
    : [schema];

/**
 * Error schemas are never compiled when a function is registered, since Convex
 * does not validate errors, so they may hold shapes no validator describes.
 * Those compile to a failure here.
 */
const compileErrors = (schemas: ReadonlyArray<Schema.Top>) =>
  schemas.map((schema) =>
    Effect.runSync(Effect.result(compileAst(Schema.toEncoded(schema).ast))),
  );

const describeErrors = (
  compiled: ReturnType<typeof compileErrors>,
): Schema.Json =>
  unionOf(
    keyed([
      ...membersOf(Array.getSuccesses(compiled)).map(([, json]) => json),
      ...Array.getFailures(compiled).map((error) => ({
        kind: "unsupported",
        reason: error.message,
      })),
    ]),
  );

/**
 * Compare the validators Convex would compile for the contract and for the host
 * function, both in the application's ID scope, so a component's IDs are
 * strings on both sides and the host's own IDs stay `v.id`. A host that is
 * itself a component registers its own IDs as `v.id` in its scope, which this
 * check cannot see and compares as strings. Args and returns must be equal.
 * Every error the host may fail with, its middleware's included, must be one
 * the contract declares: the same schema, or one compiling to the same
 * validator.
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

  const declared = ownError(provenance).flatMap(errorAlternatives);
  const undeclared = [
    ...ownError(ref),
    ...MiddlewareSpec.errorSchemas(ref.middlewareSpecs),
  ]
    .flatMap(errorAlternatives)
    .filter((schema) => !declared.includes(schema));
  if (undeclared.length > 0) {
    const expectedErrors = compileErrors(declared);
    const actualErrors = compileErrors(undeclared);
    const keys = new Set(
      membersOf(Array.getSuccesses(expectedErrors)).map(([key]) => key),
    );
    if (
      Array.getFailures(actualErrors).length > 0 ||
      !membersOf(Array.getSuccesses(actualErrors)).every(([key]) =>
        keys.has(key),
      )
    ) {
      return mismatch(
        "error",
        describeErrors(expectedErrors),
        describeErrors(actualErrors),
      );
    }
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
