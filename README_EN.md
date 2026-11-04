# agent-claim-network · ACN memory framework

[中文](README.md) · [Illustrated user handbook (HTML, Chinese)](docs/user-guide.html) · [Documentation](docs/index.md)

A knowledge and memory plugin for DeepSeek Harness (DSH). It extracts scoped, evidence-backed lessons from work, makes them available to later conversations, and optionally connects agents to ACN team services.

This repository contains the TypeScript plugin, web settings, prompts and tests. DSH owns the agent loop, context compaction, sessions and default file tools. The plugin manages knowledge and memory. Router and Maintainer are separate services deployed by your team.

## Capabilities

| Capability | Purpose |
| --- | --- |
| Recap and Finalize | Extract reusable Claims and source Traces from new conversation content, manually, after idle thresholds, or at archive time |
| Knowledge reuse | Let agents retrieve existing lessons and assess their scope and evidence for the current task |
| Team collaboration | Query Router, share Claims, report disputes and internalize suggestions from Maintainer |
| Dream | Clean up temporary records and consolidate related knowledge while preserving conditions, versions and evidence limits; model requests have a per-run budget |
| Private Memory | Keep stable experience and user preferences separate from team knowledge |
| Knowledge and activity UI | Inspect local knowledge, sources, processing results, delivery and recovery actions |

Each work configuration owns an Agent ID, knowledge and private memory. Projects using the same configuration share that store; configurations are isolated. Solo mode requires no team services and sends no team requests.

![ACN work configurations in DSH, Chinese UI](docs/assets/upstream-settings.jpg)

## Install and start

Version `0.1.0` is not publicly released. If you already have a trusted `.tgz`, install it directly in DSH. To build from source, use Node `^22.19.0 || >=24.0.0` and pnpm `11.25.0`:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
```

1. Start DSH. In **Plugins → Add plugin → Install third-party plugin**, enter the tarball's absolute path on the **computer running DSH**, then install and enable it.
2. Open **Settings → ACN settings**, create a work configuration, enter a stable Agent ID and save. Team members should confirm the ID with their administrator.
3. Choose a **Knowledge model** under **Knowledge and model**. This is separate from the chat model beside the composer; the default knowledge directory is usually sufficient.
4. Create a blank conversation, confirm the ACN configuration before sending the first message, and work normally. Use **ACN → Recap this conversation**, then inspect **Knowledge and activity**.

New conversations prefer the valid configuration of the most recently created ordinary conversation in the same project, otherwise the global default. Ownership is fixed after the first message. Pre-install conversations and conversations started without a configuration remain available for ordinary chat, but cannot enable ACN midway; create a new conversation to use knowledge and memory.

The **[HTML user handbook](docs/user-guide.html)** contains the complete illustrated walkthrough in Chinese. Download and open it in a browser; images are embedded for offline sharing and printing. A short [Markdown entry](docs/user-guide.md) remains available for repository browsing.

## Team use

Obtain Router and Maintainer URLs, your Agent ID and, if required, a team key from the administrator. Enable team services in the configuration, enter the details, check connectivity and save. The key is masked by default and stored by DSH; plugin configuration retains only its managed reference.

Shared knowledge enters the delivery queue after formation. Other members discover it through Router. Maintainer suggestions enter Inbox and may update local knowledge only after agent internalization. **Local completion, team delivery and member adoption are separate stages.** Arbitration suggestions go to direct holders of the disputed Claims, rather than every member.

Traces and private Memory are not directly uploaded to the team. Private memory review still uses the selected model provider. A Router without LLM reranking is currently recommended: changing candidate sets can block automatic arbitration adoption. See the [team walkthrough](docs/user-guide.html#team) and [known limitations](docs/outstanding-issues.md).

## Compatibility and documentation

Declared DSH range: `>=0.2.1-rc.2 <0.3.0`. macOS has local acceptance coverage. Windows path and file protection support and CI are included; Windows desktop device acceptance is still pending. The same JavaScript package is used across supported host platforms. See [DSH compatibility](docs/dsh-compat.md).

| Topic | Reference |
| --- | --- |
| Installation and everyday use | [Illustrated HTML handbook](docs/user-guide.html) |
| Settings, storage and model behavior | [Configuration](docs/config.md) |
| Commands, tools, migration and recovery | [Command reference](docs/command-reference.md) |
| Modules and data ownership | [Architecture](docs/architecture.md) |
| Building and testing | [Development](docs/development.md) |

## Repository and development

`src/` contains implementation and web UI; `prompts/` contains knowledge-processing prompts; `tests/` covers regression and service contracts; `scripts/` contains verification tooling; `docs/` contains documentation. `cordis.patch.yml` registers components and `locale/` contains Chinese and English resources.

```sh
pnpm typecheck
pnpm lint
pnpm check:security
pnpm check:docs
pnpm test
```

Automated tests use temporary directories and local test models. Service contract tests also require an ACN source checkout. See the [development guide](docs/development.md) for all checks and the [changelog](CHANGELOG.md) for changes.

License: [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE).

## Original ACN repository

The native ACN application, Router, Maintainer and deployment instructions are maintained in [FTShare-Lab/agent-claim-network](https://github.com/FTShare-Lab/agent-claim-network). This repository maintains the DSH plugin implementation.
