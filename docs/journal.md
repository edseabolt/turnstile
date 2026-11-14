# Journal: catalog, replay, and tamper evidence

The journal is the plugin's only persistence edge. It lives outside the repo
at `~/.local/share/opencode/metrics/`. This document is the developer
reference for the file layout, the entry-type catalog, rotation, replay, and
tamper evidence. The state-machine view lives in
[architecture/persistence.md](architecture/persistence.md).

## Contents

| Section                                         | File                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| File layout                                     | [journal/file-layout.md](journal/file-layout.md) |
| Entry-type catalog (43 types)                   | [journal/entry-types.md](journal/entry-types.md) |
| Rotation and per-session sinks                  | [journal/rotation.md](journal/rotation.md)       |
| Replay on restart                               | [journal/replay.md](journal/replay.md)           |
| Tamper evidence: the hash chain                 | [journal/chain.md](journal/chain.md)             |
| Tamper evidence: anchors and verification sinks | [journal/anchors.md](journal/anchors.md)         |
