import { RegisteredConvexFunction, RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema";
import authoring from "../../authoring.impl";

export default RegisteredFunctions.buildForGroup<typeof import("../../authoring.spec")["default"]>(databaseSchema, authoring, RegisteredConvexFunction.make);
