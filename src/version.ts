/**
 * Single source of truth for Koda's version string.
 * All files import from here — never hardcode a version elsewhere.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf-8"));

export const VERSION: string = pkg.version;
