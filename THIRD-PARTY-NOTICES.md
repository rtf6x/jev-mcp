# Third-party notices

This repository is MIT licensed (see `LICENSE`). Parts of it are adapted from third-party
MIT-licensed work, listed here with the licence text they carry.

## jkudish/jev-mcp

- Project: <https://github.com/jkudish/jev-mcp>
- Ported from: commit `53fe5756252956863af2ecbd2952339352e82e15` (version `0.11.0`, 2026-09-29)
- Upstream files adapted: `src/index.ts` (the twelve MCP tools and their question design),
  `src/lib.ts` (question/answer/policy helpers), `test/e2e.test.mjs` (the end-to-end battery,
  replayed here against a stub endpoint instead of the live API)
- What was **not** ported: `src/provider.ts` and the `@jkudish/jev-agent-tools` transport. This
  server posts to the one endpoint configured in `.env` through `mcp-server/src/forward.ts`.

Adapted files (a one-line header names the upstream file in each):

| This repository | Upstream |
| --- | --- |
| `mcp-server/src/jev/limits.ts` | `src/lib.ts` |
| `mcp-server/src/jev/text.ts` | `src/lib.ts` |
| `mcp-server/src/jev/policy.ts` | `src/lib.ts` |
| `mcp-server/src/jev/regex.ts` | `src/lib.ts` |
| `mcp-server/src/jev/questions.ts` | `src/index.ts` |
| `mcp-server/src/jev/answers.ts` | `src/index.ts` |
| `mcp-server/src/jev/call.ts` | `src/index.ts` |
| `mcp-server/src/tools/*.ts` | `src/index.ts` |
| `mcp-server/test/tools-*.test.ts` | `test/e2e.test.mjs` |

Upstream in turn credits its own review/gate question design to `burnigtm/jev-mcp` (MIT), via
PR #2 by `rimusz`; that attribution is carried in the header comments of
`mcp-server/src/tools/patch-review.ts`, `mcp-server/src/tools/review.ts` and
`mcp-server/src/tools/gate.ts`.

The `@typesafe-ai/sdk` question and answer shapes (`NoulQuestion`, `ChoiceQuestion`,
`ScoreQuestion`, `NoulResponse`, `ChoiceResponse`, `ScoreResponse`, `SystemOneResult`) were
consulted to keep the wire format faithful. The SDK itself is **not** a dependency of this
repository.

### Licence text

```
MIT License

Copyright (c) 2026 Joey Kudish

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
