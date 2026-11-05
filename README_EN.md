# ACN Memory Framework

[中文](README.md) · [User guide (Chinese)](docs/user_guide.md) · [Developer documentation](docs/index.md)

**Keep useful experience from your work and reuse it across conversations and teams.**

ACN is a knowledge and memory plugin for DeepSeek Harness (DSH). Start with a personal configuration to turn work conversations into reusable conclusions with evidence and a clear scope. Connect to a team to discover other agents' knowledge, share findings, and receive feedback.

| Capability | What it provides |
| --- | --- |
| Session recap | Extract reusable conclusions and retain their sources |
| Knowledge reuse | Look up experience and assess its evidence and applicability |
| Team collaboration | Search shared knowledge, contribute findings, report disputes, and process feedback |
| Private memory | Keep lasting preferences and experience separate from shared knowledge |
| Dream | Review existing knowledge, retire temporary records, and consolidate related findings |
| Knowledge and activity | Read records, return to source conversations, and follow progress or failures |

![ACN work configurations in DSH](docs/assets/upstream-settings.png)

## Get started

The package name is **`@ftai/dsh-plugin-acn`**. It has not been published to npm yet. For now, use a prebuilt `.tgz` supplied by the distributor. Once published, enter the package name in the same installation dialog. Desktop users do not need to build the plugin.

1. In DSH, open **Plugins → Add plugin**, enter the package path, then install and enable it.
2. Open **ACN settings** and create a work configuration. For personal use, choose a stable Agent ID and leave team services off.
3. Select a knowledge-processing model under **Knowledge and models**. Start a new conversation and confirm its ACN configuration beside the composer.
4. After completing useful work, choose **Recap session** from the ACN menu and review the result in **Knowledge and activity**.

Each configuration has its own knowledge and private memory. Projects using the same configuration share that knowledge; separate configurations remain isolated. A conversation's configuration is fixed after it starts. See the [illustrated user guide](docs/user_guide.md) for details.

## Connect a team

This plugin implements the **Agent (A) side**. **Your team must deploy Maintainer (M) and Router (R) separately using the [official ACN repository](https://github.com/FTShare-Lab/agent-claim-network).** The plugin does not start these services for you.

After deployment, the administrator supplies an Agent ID, both service URLs, and a team key when authentication is enabled. Enable **Connect team services** in a work configuration, enter these details, and check the connection. Personal use needs neither service and sends no team requests.

In team mode, formed Claims and Disputes are shared with Maintainer. Router results are candidates for the assistant to assess; the Agent processes team suggestions against its local knowledge. Traces and private Memory are not uploaded directly to the team. Knowledge processing uses the selected model provider.

## Maintenance and development

- [User guide, in Chinese](docs/user_guide.md): everyday operations with DSH screenshots.
- [Configuration reference](docs/config.md): advanced options and complete configuration.
- [Development guide](docs/development.md): build, test, package, and installation checks.
- [Compatibility](docs/dsh-compat.md) and [known limitations](docs/outstanding-issues.md): versions, platforms, and operational boundaries.

Implementation lives in `src/`, prompts in `prompts/`, and tests in `tests/`. Supported desktop platforms are Apple Silicon Macs (macOS 13+) and Windows; consult the compatibility document for the actual validation coverage.

License: [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
