import { RegisteredConvexFunction, RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema";
import componentAuthoring from "../../../groups/componentAuthoring.impl";

export default RegisteredFunctions.buildForGroup<typeof import("../../../groups/componentAuthoring.spec")["default"]>(databaseSchema, componentAuthoring, RegisteredConvexFunction.make);
