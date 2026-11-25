#!/usr/bin/env node
// Stands in for a terminal emulator: records how it was asked to start Claude, runs nothing.
import { appendFileSync } from "node:fs";
appendFileSync(process.env.DASH_TERM_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
