import { Component } from "@confect/core";
import spec from "./spec";
import { scope } from "./id";

const component: Component.Component<typeof spec, typeof scope, "counters" | "systemIds" | "_storage" | "_scheduled_functions"> = Component.make(spec, scope, ["counters", "systemIds", "_storage", "_scheduled_functions"]);
export default component;
