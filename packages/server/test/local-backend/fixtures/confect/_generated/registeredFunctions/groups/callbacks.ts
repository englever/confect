import { RegisteredConvexFunction, RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema";
import callbacks from "../../../groups/callbacks.impl";

export default RegisteredFunctions.buildForGroup<typeof import("../../../groups/callbacks.spec")["default"]>(databaseSchema, callbacks, RegisteredConvexFunction.make);
