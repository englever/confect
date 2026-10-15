import { HttpRouter } from "@confect/server";
import schema from "../confect/_generated/schema";
import http from "../confect/http";

export default HttpRouter.forSchema(schema)(http.routes, { api: http.api });
