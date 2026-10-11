#!/usr/bin/env node
import { runCli } from "./core/program.js";
import { provider } from "./provider.js";

runCli(provider, new URL("../package.json", import.meta.url));
