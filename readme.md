<p align="center">
  <a href="https://github.com/simonepri/refined-antigravity-acp">
    <img src="assets/logo.svg" alt="Refined Antigravity ACP Logo" width="320">
  </a>
</p>

<h1 align="center">Refined Antigravity ACP</h1>

<p align="center">
  <!-- Implementation -->
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&amp;logoColor=white" alt="Written in TypeScript">
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/runtime-Node.js_>=22-339933?logo=node.js&amp;logoColor=white" alt="Node.js 22+">
  </a>
  <a href="https://pnpm.io/">
    <img src="https://img.shields.io/badge/package_manager-pnpm-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm">
  </a>
  <br>
  <!-- Quality & Tooling -->
  <a href="https://oxc.rs/">
    <img src="https://img.shields.io/badge/formatter-oxfmt-orange?logo=rust&amp;logoColor=white" alt="oxfmt">
  </a>
  <a href="https://oxc.rs/">
    <img src="https://img.shields.io/badge/linter-oxlint-orange?logo=rust&amp;logoColor=white" alt="oxlint">
  </a>
  <a href="https://publint.dev/">
    <img src="https://img.shields.io/badge/packaging-publint-2A52BE?logo=npm&amp;logoColor=white" alt="publint">
  </a>
  <a href="https://github.com/trumppet/fallow">
    <img src="https://img.shields.io/badge/dead_code-fallow-5C2D91?logoColor=white" alt="fallow">
  </a>
  <a href="https://github.com/rhysd/actionlint">
    <img src="https://img.shields.io/badge/workflows-actionlint-2088FF?logo=githubactions&amp;logoColor=white" alt="actionlint">
  </a>
  <br>
  <!-- Verification -->
  <a href="https://github.com/simonepri/refined-antigravity-acp/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/simonepri/refined-antigravity-acp/ci.yml?branch=main&amp;label=CI&amp;logo=githubactions&amp;logoColor=white" alt="CI status">
  </a>
  <a href="https://vitest.dev/">
    <img src="https://img.shields.io/badge/tests-vitest-729B1B?logo=vitest&amp;logoColor=white" alt="Vitest unit tests">
  </a>
  <br>
  <!-- Distribution -->
  <a href="https://github.com/simonepri/refined-antigravity-acp/stargazers">
    <img src="https://img.shields.io/github/stars/simonepri/refined-antigravity-acp?style=flat&amp;logo=github&amp;logoColor=white" alt="GitHub stars">
  </a>
  <a href="https://github.com/googleapis/release-please">
    <img src="https://img.shields.io/badge/released_with-Release_Please-4285F4?logo=google&amp;logoColor=white" alt="Released with Release Please">
  </a>
  <a href="https://github.com/getpaseo/paseo">
    <img src="https://img.shields.io/badge/ecosystem-Paseo_ACP_Provider-20744A?logo=buffer&amp;logoColor=white" alt="Paseo ACP Provider">
  </a>
  <a href="license">
    <img src="https://img.shields.io/github/license/simonepri/refined-antigravity-acp" alt="MIT license">
  </a>
</p>

<p align="center">
  <strong>A hardened wrapper around Google's official Antigravity ACP binary.</strong>
</p>

---

## Overview

**Refined Antigravity ACP** is a proxy wrapper around Google's official Antigravity ACP binary ([`agy_acp_server.par`](https://dl.google.com/agy-extensions/releases/)).

Google's binary executes models, agent loops, and tool calls. This proxy intercepts the ACP stream between editor and server to fix upstream crashes and deadlocks, normalize MCP traffic, and integrate with **Paseo**, **Zed**, and other ACP clients.

```mermaid
flowchart LR
    subgraph Editors["Supported ACP Clients"]
        PaseoUI["Paseo<br>(ACP Agent Provider)"]
        ZedUI["Zed Editor<br>(Stdio Agent)"]
        OtherUI["Neovim / JetBrains / Custom<br>(Standard ACP)"]
    end

    subgraph Wrapper["Refined Antigravity ACP (Proxy & Hardening Layer)"]
        direction TB

        Supervisor["Process Supervisor<br>• Subprocess Lifecycle & Health<br>• Transparent Crash Recovery<br>• Multi-Session State Cache"]

        subgraph Pipeline["Bidirectional ACP Pipeline"]
            direction TB
            Outbound["Outbound Stream<br>• Request & Option Normalization<br>• Workspace Context Injection<br>• MCP Port & URL Rewriting"]
            Inbound["Inbound Stream<br>• Output & Stream Sanitization<br>• Progress & Plan Synthesis<br>• Interruption Leak Cleanup"]
            Telemetry["Telemetry & Diagnostics<br>• Real-time Stderr Event Tracking<br>• SQLite Checkpoint & History Repair<br>• Token Usage Extraction"]
        end

        McpProxy["Loopback MCP Proxy Pool<br>• Dynamic Endpoint Remapping<br>• Protocol Version Adaptation"]

        Supervisor <--> Pipeline
        Supervisor <--> McpProxy
    end

    subgraph Upstream["Google Official Backend"]
        Kernel["agy_acp_server.par<br>(Google Subprocess)"]
        LocalDb[(Local SQLite Store<br>Conversations & Steps)]
        GeminiCloud["Google DeepMind / Gemini Cloud"]

        Kernel <-->|gRPC / HTTPS| GeminiCloud
        Kernel <-->|WAL Journal| LocalDb
    end

    Editors <-->|Stdio NDJSON CLI| Supervisor
    Supervisor <-->|Standard ACP NDJSON| Kernel
    Pipeline -.->|Direct Read / Heal| LocalDb
    McpProxy <-->|HTTP Rewriting| Kernel

    classDef editor fill:#20744A,stroke:#10B981,color:#fff,stroke-width:2px
    classDef wrapper fill:#0F172A,stroke:#3B82F6,color:#fff,stroke-width:2px
    classDef component fill:#1E293B,stroke:#60A5FA,color:#fff,stroke-width:1px
    classDef google fill:#18181B,stroke:#71717A,color:#fff,stroke-width:2px
    classDef db fill:#312E81,stroke:#818CF8,color:#fff,stroke-width:2px

    class PaseoUI,ZedUI,OtherUI editor
    class Supervisor,Pipeline,McpProxy,Outbound,Inbound,Telemetry component
    class Kernel,GeminiCloud google
    class LocalDb db
```

The matrix below documents upstream defects across process startup, turn execution, cancellation, and session replay. Each entry links directly to tests demonstrating the defect (**Problem**) and the fix (**Solution**).

> [!TIP]
>
> ### ⭐️ Help Retire These Patches
>
> Refined Antigravity ACP is a transitional hardening layer. When Google resolves a defect in an official release, the corresponding problem test verifies the fix and the wrapper retires the patch.
>
> To help prioritize upstream fixes:
>
> - **Star the repository**: Community visibility signals to the Google Antigravity team which upstream defects impact real users.
> - **Report new issues**: If you encounter an unhandled crash, deadlock, or protocol edge case, [open an issue](https://github.com/simonepri/refined-antigravity-acp/issues). Every report includes a reproducible problem test and a solution test.

| Defect                                                                               | Upstream Problem                                                                                                                                                                                                                                                                                              | Solution                                                                                                                                                                                                                                                                                                              |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Missing Localharness Binary**](src/fixes/missing-localharness/index.ts)           | **Problem**: `agy_acp_server` invokes sibling `./localharness_external`. When relocated or spawned in an isolated directory without `$ANTIGRAVITY_HARNESS_PATH`, it crashes on `session/new`.<br>🔗 [`problem: startup crash`](src/fixes/missing-localharness/index.e2e.test.ts#L20)                          | Searches standard install paths, downloads the official package if missing, and exports the resolved `$ANTIGRAVITY_HARNESS_PATH`.<br>🔗 [`solution: harness resolution`](src/fixes/missing-localharness/index.e2e.test.ts#L38)                                                                                        |
| [**Missing Custom System Prompt**](src/fixes/missing-system-prompt/index.ts)         | **Problem**: Stock ACP protocol does not support injecting custom workspace rules, agent personas, or profile system prompts.<br>🔗 [`problem: missing system prompt context`](src/fixes/missing-system-prompt/index.e2e.test.ts#L6)                                                                          | Injects client-configured `systemPrompt` (via `_meta.systemPrompt` or nested `_meta.<client>.systemPrompt`) and tool visibility guidance into prompt turns without polluting saved history.<br>🔗 [`solution: prompt injection`](src/fixes/missing-system-prompt/index.e2e.test.ts#L15)                               |
| [**Unadvertised Workspace Slash Skills**](src/fixes/missing-slash-skills/index.ts)   | **Problem**: Raw ACP only advertises built-in model commands and ignores custom workspace skills defined in `.agents/skills` or `.gemini/skills`.<br>🔗 [`problem: missing slash skills`](src/fixes/missing-slash-skills/index.e2e.test.ts#L40)                                                               | Discovers `SKILL.md` files across all configured workspace directories and dynamically augments `available_commands_update`.<br>🔗 [`solution: skill augmentation`](src/fixes/missing-slash-skills/index.e2e.test.ts#L73)                                                                                             |
| [**Subagent Deadlock & Hang**](src/fixes/subagent-hang/index.ts)                     | **Problem**: Subprocesses can enter unmonitored hangs or panic (`could not find doneCh for checkpoint`) during background task execution.<br>🔗 [`problem: unmonitored hang`](src/fixes/subagent-hang/index.e2e.test.ts#L7)                                                                                   | Monitors telemetry activity and stderr panics to trigger process recycling without mutating upstream Python bytecode.<br>🔗 [`solution: hang telemetry recycling`](src/fixes/subagent-hang/index.e2e.test.ts#L22)                                                                                                     |
| [**Malformed Stream Syntax & LaTeX**](src/fixes/malformed-stream-syntax/index.ts)    | **Problem**: LLM outputs unquoted node labels with parentheses (`id[Label (Prod)]`) and raw LaTeX math (`\\le`), crashing frontend Mermaid and markdown parsers.<br>🔗 [`problem: syntax normalization`](src/fixes/malformed-stream-syntax/index.e2e.test.ts#L42)                                             | Wraps parenthetical labels in quotes `["..."`] and converts LaTeX escapes to clean Unicode characters (`≤`, `→`, `≠`) across streaming chunks.<br>🔗 [`solution: stream sanitizer`](src/fixes/malformed-stream-syntax/index.e2e.test.ts#L42)                                                                          |
| [**Active Foreground Turn Collision**](src/fixes/active-turn-collision/index.ts)     | **Problem**: Sending a prompt while the model is executing tool calls either crashes or is rejected with _"A foreground turn is already active"_.<br>🔗 [`problem: foreground active collision`](src/fixes/active-turn-collision/index.e2e.test.ts#L13)                                                       | Categorizes mid-turn inputs (side questions, course corrections, or stop requests) with non-destructive steering directives and prompt retries.<br>🔗 [`solution: user steering`](src/fixes/active-turn-collision/index.e2e.test.ts#L26)                                                                              |
| [**Interruption Cancellation Leak**](src/fixes/cancellation-leak/index.ts)           | **Problem**: Interrupted turns leak raw internal Go/Python cancellation exception strings (_"context canceledThe request was cancelled by the client."_) directly into assistant message chunks.<br>🔗 [`problem: raw cancellation leak`](src/fixes/cancellation-leak/index.e2e.test.ts#L6)                   | Drops raw upstream cancellation error chunks so editor chat feeds remain clean on interruption.<br>🔗 [`solution: cancellation drop`](src/fixes/cancellation-leak/index.e2e.test.ts#L11)                                                                                                                              |
| [**Stale Ephemeral MCP Endpoints**](src/fixes/stale-mcp-endpoints/index.ts)          | **Problem**: When a hung child process is recycled, resending initial `mcpServers` with outdated localhost ports fails because proxy endpoints have changed.<br>🔗 [`problem: stale proxy port`](src/fixes/stale-mcp-endpoints/index.e2e.test.ts#L20)                                                         | Uses `McpProxyPool` to dynamically intercept, remap, and heal MCP tool URLs across process restarts.<br>🔗 [`solution: proxy URL remapping`](src/fixes/stale-mcp-endpoints/index.e2e.test.ts#L20)                                                                                                                     |

## Setup

Install globally:

```bash
npm install -g @simonepri/refined-antigravity-acp
which refined-antigravity-acp
```

> [!TIP]
> The wrapper downloads [`agy_acp_server.par`](https://dl.google.com/agy-extensions/releases/) if not already installed locally.

### 1. Paseo (ACP Agent Provider)

Register the wrapper in `~/.paseo/config.json` under `agents.providers`:

```json
{
  "agents": {
    "providers": {
      "refined-antigravity-acp": {
        "extends": "acp",
        "label": "Antigravity",
        "command": ["/usr/local/bin/refined-antigravity-acp"],
        "enabled": true
      }
    }
  }
}
```

Zero-install alternative: `"command": ["pnpm", "dlx", "@simonepri/refined-antigravity-acp"]`.

---

### 2. Zed Editor (ACP Agent)

Add `refined-antigravity-acp` to your Zed `settings.json` under `agent.profiles`:

```json
{
  "agent": {
    "profiles": {
      "antigravity": {
        "type": "acp",
        "command": "/usr/local/bin/refined-antigravity-acp",
        "args": []
      }
    }
  }
}
```

Zero-install alternative: `"command": "pnpm", "args": ["dlx", "@simonepri/refined-antigravity-acp"]`.

---

### 3. Standalone CLI and Other ACP Editors

Run directly from any terminal or editor speaking standard ACP over stdio:

```bash
refined-antigravity-acp
```

Zero-install alternative: `pnpm dlx @simonepri/refined-antigravity-acp`.

---

## Authentication

Google's ACP server handles authentication directly. On initialization, the server advertises standard ACP `authMethods` (Google OAuth, Gemini Enterprise, Gemini API keys, or Agent Platform).

For OAuth logins, the server runs a local browser login flow and saves credentials to the operating system keychain. The CLI requires no manual authentication step.

---

## Configuration & Environment Variables

| Variable                           | Default                  | Description                                                                                                                                                                                                                                                        |
| :--------------------------------- | :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFINED_AGY_OFFICIAL_ACP_VERSION` | `1.2.1`                  | Version of the official upstream Google Antigravity ACP binary (`agy_acp_server.par`) to download if not installed locally. (Falls back to `REFINED_AGY_VERSION` if set).                                                                                          |
| `REFINED_AGY_ACP_BIN`              | Auto-detected            | Custom path to an `agy_acp_server.par` binary.                                                                                                                                                                                                                     |
| `REFINED_AGY_RECYCLE_TIMEOUT_MS`   | `10000`                  | Timeout (in ms) when respawning and resyncing a replacement process after an upstream Antigravity crash or deadlock (e.g. subagent channel panic). Caps how long internal initialization, session loading, and mode restoration requests can take before retrying. |
| `REFINED_AGY_TRACE`                | `0`                      | Set to `1` to trace inbound/outbound ACP JSON-RPC message ids to stderr and restore the full upstream debug log (normally filtered).                                                                                                                               |
| `REFINED_AGY_DATA_DIR`             | `~/.refined-antigravity` | Base directory for the MCP proxy's remembered-port configuration.                                                                                                                                                                                                  |

---

## Protocol Coverage

Refined Antigravity ACP implements the **[Agent Client Protocol (ACP)](https://agentclientprotocol.com)** specification across two layers:

- **Direct Passthrough**: Requests and notifications requiring no modification pass through unchanged: client filesystem operations (`fs/*`), terminals (`terminal/*`), authentication (`authenticate`, `logout`), permission requests (`session/request_permission`), and MCP bridge channels.
- **Hardening and Telemetry**: The wrapper intercepts session methods to prevent deadlocks, repair database state, and synthesize missing ACP notifications (`usage_update` token metrics and `plan` subagent tracking).

> [!NOTE]
> All synthesized and modified messages are verified against the canonical ACP JSON Schema (Draft 2020-12) and type-checked against `@agentclientprotocol/sdk` in [`src/core/acp-conformance.test.ts`](src/core/acp-conformance.test.ts).

---

## Development

```bash
pnpm install
pnpm run check       # runs format:check, lint, typecheck, and dead-code
pnpm run test        # fast, hermetic unit tests (no auth required)
pnpm run test:e2e    # end-to-end integration tests (requires local agy login)
```

---

## Contributing

Every fix pull request must follow this structure:

1. **Directory**: Place the fix in `src/fixes/<bug-name>/`, named after the bug (for example, `dangling-tool-calls`). Do not prefix with issue numbers.
2. **Header**: Add a JSDoc block with `Problem:` and `Solution:` sections at the top of `src/fixes/<bug-name>/index.ts`.
3. **Tests**: Include both an upstream reproduction (`problem: <description>`) and a fix verification (`solution: <description>`).
4. **Exports**: Export the fix from [`src/fixes/index.ts`](src/fixes/index.ts) and register it in [`src/index.ts`](src/index.ts).
5. **Documentation**: Add a row to the table in [`readme.md`](readme.md) linking the fix and tests.
6. **Verification**: Run quality checks before submitting:
   ```bash
   pnpm run check && pnpm run build && pnpm test
   ```

---

## Disclaimer

This is an independent open-source project and is not affiliated with, authorized, or endorsed by Google LLC. "Antigravity", "Gemini", and Google are trademarks of Google LLC.

---

## License

MIT © [Simone Primarosa](https://github.com/simonepri)
