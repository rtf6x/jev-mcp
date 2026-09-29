// Ported from jkudish/jev-mcp src/index.ts (MIT): the twelve-tool set. See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.ts";
import { registerAuditTool } from "./audit.ts";
import { registerClassifyTool } from "./classify.ts";
import { registerCompareTool } from "./compare.ts";
import { registerDecideTool } from "./decide.ts";
import { registerExtractTool } from "./extract.ts";
import { registerFindTool } from "./find.ts";
import { registerGateTool } from "./gate.ts";
import { registerNoulTool } from "./noul.ts";
import { registerRerankTool } from "./rerank.ts";
import { registerReviewTool } from "./review.ts";
import { registerScreenTool } from "./screen.ts";
import { registerVerifyTool } from "./verify.ts";

/** Every tool this server offers, in registration order. */
export function registerAllTools(server: McpServer, config: Config): void {
  registerVerifyTool(server, config);
  registerScreenTool(server, config);
  registerNoulTool(server, config);
  registerFindTool(server, config);
  registerRerankTool(server, config);
  registerClassifyTool(server, config);
  registerDecideTool(server, config);
  registerCompareTool(server, config);
  registerExtractTool(server, config);
  registerAuditTool(server, config);
  registerReviewTool(server, config);
  registerGateTool(server, config);
}
