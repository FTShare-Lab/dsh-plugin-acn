# ACN Knowledge Framework

[中文](README.md) · [User guide (Chinese)](docs/user_guide.md) · [Developer documentation](docs/index.md)

**Turn each agent's experience into knowledge the team can reuse.**

ACN is a knowledge collaboration plugin for DeepSeek Harness (DSH). It turns work conversations into reusable conclusions with evidence and a clear scope. Connected agents can share findings, search each other's knowledge, report disagreements, and receive team guidance. You can also use it individually to build knowledge across your own conversations; connecting a team brings out ACN's full collaborative value.

| Capability | What it provides |
| --- | --- |
| Team collaboration | Search shared knowledge, contribute findings, report disputes, and process feedback |
| Session recap | Extract reusable conclusions and retain their sources |
| Knowledge reuse | Look up experience and assess its evidence and applicability |
| Dream | Review existing knowledge, retire temporary records, and consolidate related findings |
| Knowledge and activity | Read records, return to source conversations, and follow progress or failures |

![ACN work configurations in DSH](docs/assets/upstream-settings.png)

This plugin manages reusable experience centered on Claims and supports sharing across a connected team. It does not maintain or manage private Memory. Knowledge extraction excludes calls and results of tools whose names contain `memory`, case-insensitively.

## Get started

In DSH, open **Plugins → Add plugin**, enter **`@ftai/dsh-plugin-acn`**, then install and enable it. To install a specific version, use a name such as `@ftai/dsh-plugin-acn@0.1.0`.

1. Ask your team administrator for an Agent ID, Maintainer and Router URLs, and a team key if authentication is enabled (optional). Open **ACN settings**, create a work configuration, enable **Connect team services**, enter these details, check the connection, and save.
2. Select a knowledge-processing model under **Knowledge and models**. Start a new conversation and confirm its ACN configuration beside the composer.
3. After completing useful work, choose **Recap session** from the ACN menu and review the result in **Knowledge and activity**.

For individual use, create a configuration with a stable Agent ID and leave **Connect team services** off. You can still accumulate and reuse local knowledge.

Each configuration has its own knowledge. Projects using the same configuration share that knowledge; separate configurations remain isolated. A conversation's configuration is fixed after it starts. See the [illustrated user guide](docs/user_guide.md) for details.

## Updates

In the [GitHub repository](https://github.com/FTShare-Lab/dsh-plugin-acn), choose **Watch → Custom → Releases** to subscribe to release notifications. DSH currently does not notify you of new versions of this plugin or upgrade it automatically.

Before updating, open **Knowledge and activity → Activity** and check that recent tasks are no longer **Queued** or **Running**. Uninstall ACN from the DSH plugin page, then add `@ftai/dsh-plugin-acn` again to install the new version. Uninstalling leaves your knowledge directory intact. Check your work configurations and knowledge directory after reinstalling, then start a new conversation. Adding the same package again without uninstalling reports that it is already installed; it does not create a second copy. See [Update the plugin](docs/user_guide.md#更新插件) in the Chinese guide.

## Connect a team

This plugin implements the **Agent (A) side**. **Your team must deploy Maintainer (M) and Router (R) separately using the [official ACN repository](https://github.com/FTShare-Lab/agent-claim-network).** The plugin does not start these services for you.

After deployment, the administrator supplies an Agent ID, both service URLs, and a team key when authentication is enabled (optional). Enable **Connect team services** in a work configuration, enter these details, and check the connection. Personal use needs neither service and sends no team requests.

In team mode, formed Claims and Disputes are shared with Maintainer. Router results are candidates for the assistant to assess; the Agent processes team suggestions against its local knowledge. Traces are not uploaded directly to the team. Knowledge processing uses the selected model provider.

## Maintenance and development

- [User guide, in Chinese](docs/user_guide.md): everyday operations with DSH screenshots.
- [Configuration reference](docs/config.md): advanced options and complete configuration.
- [Development guide](docs/development.md): build, test, package, and installation checks.
- [Compatibility](docs/dsh-compat.md) and [known limitations](docs/outstanding-issues.md): versions, platforms, and operational boundaries.

Implementation lives in `src/`, prompts in `prompts/`, and tests in `tests/`. Supported desktop platforms are Apple Silicon Macs (macOS 13+) and Windows; consult the compatibility document for the actual validation coverage.

License: [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
