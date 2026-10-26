# agent-claim-network

[中文](README.md)

**Distill reusable knowledge and memories from agent work traces, and let experience flow across your team.**

ACN adds knowledge and private memory to DeepSeek Harness (DSH). DSH still owns the agent loop, context compaction, sessions and default file tools. ACN does not replace the host harness.

## Capabilities

| Feature | What it does |
| --- | --- |
| Claims and Traces | Store scoped, referenceable knowledge with evidence, confidence and provenance; read and revise it when relevant |
| Recap and Finalize | Extract reusable knowledge after host compaction or at the end of work; inspect persistent jobs and retry failures |
| Private Memory | Maintain `MEMORY.md` and `USER.md`, with frozen snapshots for sessions and no direct team upload |
| Dream | Clean up and consolidate knowledge; optionally check workspace files while preserving prior evidence and limits |
| Team collaboration | Discover claims through ACN Router, deliver knowledge to Maintainer and internalize its suggestions locally |
| Recovery and import | Resume interrupted background work and import existing ACN knowledge without overwriting targets |

## Install and configure

Version `0.1.0` remains unpublished. No public repository URL has been selected. Build a local package with Node `^22.19.0 || >=24.0.0` and pnpm `11.25.0`:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
```

In DSH, open **Plugins**, expand **Add plugin**, choose the third-party installation option and enter the tarball's absolute path. Install, enable and open **agent-claim-network**. Set an Agent ID, knowledge directory, background model and mode, then click **Save and apply**. Start a new session and run `/acn-status`. **Reload saved configuration** discards unsaved edits.

Solo mode needs no team services. Choose a stable ID such as `personal`; all projects using the same ID and directory share knowledge and private memory. Team members need distinct IDs matching their service authorization. Set both Router and Maintainer URLs and the credential environment variable **name**, never its value.

Chat and background models are selected separately. Both can use `deepseek-v4-flash-api` if it is registered in DSH. Changing identity or storage location does not migrate data; old sessions require a new session. Private memory review sends its input to the configured model provider, not to team services.

![Actual DSH configuration page, Chinese UI](docs/assets/config-identity.jpg)

The tested host is DSH `0.2.1-rc.2`. The declared range `>=0.2.1-rc.2 <0.3.0` is not a claim that every version was tested. The package identifier is `dsh-plugin-acn`; the Chinese display name is **ACN记忆框架**.

## Observed results and limits

The [EatWhich team trial](docs/validation/2026-10-26-eatwhich-team-development.md) used three real DSH identities and `deepseek-v4-flash-api` to develop a feature, discover knowledge, process disputes and propagate corrections. With Router LLM reranking disabled, both original disputes were adopted on the first arbitration round and delivered to three members. Dream and file-evidence checks also completed.

Use a **Router without LLM reranking** for this tested setup. Reranked candidate sets can vary and block Maintainer's adoption checks; that service limitation remains unresolved. These trials demonstrate specific workflows, not guaranteed autonomous recall or factual accuracy. Memory protection is not an operating-system sandbox.

Further documentation is in Chinese: [illustrated user guide](docs/user-guide.md), [configuration](docs/config.md), [command reference](docs/command-reference.md), [release and marketplace preparation](docs/release.md), [acceptance](docs/acceptance.md), [limitations](docs/outstanding-issues.md), [development](docs/development.md), [architecture](docs/architecture.md).

License: [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE).
