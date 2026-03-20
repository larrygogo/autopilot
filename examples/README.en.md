[中文](README.md) | [English](README.en.md)

# Examples

This directory contains example workflow and plugin implementations for the autopilot framework.

## Directory Structure

```
examples/
├── workflows/          # Example workflows (5 reference implementations)
│   ├── dev/            # Full development workflow (5 phases)
│   ├── req_review/     # Requirements review (2 phases)
│   ├── doc_gen/        # Document generation and review
│   ├── parallel_build/ # Parallel build workflow (fork/join)
│   └── data_pipeline/  # Data processing pipeline (forward jump + multiple terminals)
└── plugins/            # Example plugins
    └── autopilot-webui/ # WebUI management interface plugin
```

## Workflow Examples

See [`workflows/README.md`](workflows/README.md) for details.

Use `autopilot init` to automatically install example workflows to `~/.autopilot/workflows/`.

## Plugin Examples

See [`plugins/README.md`](plugins/README.md) for details.

Plugins are automatically registered after `pip install`, no framework code modifications needed.
