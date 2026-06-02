[中文](README.md) | [English](README.en.md)

# Examples

This directory contains example workflows for the autopilot framework.

## Directory Structure

```
examples/
└── workflows/          # Example workflows (reference implementations)
    ├── dev/            # Full development workflow (5 phases, incl. git push + gh PR)
    ├── req_review/     # Requirements review (2 phases)
    ├── doc_gen/        # Document generation and review
    ├── parallel_build/ # Parallel build workflow (fork/join)
    ├── data_pipeline/  # Data processing pipeline (forward jump + multiple terminals)
    └── with_human/     # Human-in-the-loop example (gate approval + ask_user)
```

## Workflow Examples

See [`workflows/README.md`](workflows/README.md) for details.

Use `autopilot init` to automatically install example workflows to `~/.autopilot/workflows/`.
