import { RegisteredConvexFunction, RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema";
import deliveries from "../../deliveries.impl";

export default RegisteredFunctions.buildForGroup<typeof import("../../deliveries.spec")["default"]>(databaseSchema, deliveries, RegisteredConvexFunction.make);
