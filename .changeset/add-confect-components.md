---
"@confect/core": minor
"@confect/server": minor
"@confect/cli": minor
"@confect/test": minor
---

Add component authoring with `confect codegen --component-dir` and `confect dev --component-dir`. Publish a component contract, bind it to installed instances with `Component.bind`, and call it with decoded arguments, results, and declared errors. IDs from separate installations have distinct types.

Use `Component.id` and `Component.schema` in host schemas, `HttpRouter.forSchema` for component HTTP routes, and `TestConfect.registerComponent` in tests. Vanilla Convex callers can use the component's encoded API.
