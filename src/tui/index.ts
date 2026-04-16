import React from "react";
import { render } from "ink";
import { App } from "./app";
import { DEFAULT_PORT } from "../client/index";

export interface TuiOptions {
  port?: number;
}

export function startTui(opts: TuiOptions = {}): void {
  const port = opts.port ?? DEFAULT_PORT;
  render(React.createElement(App, { port }));
}
