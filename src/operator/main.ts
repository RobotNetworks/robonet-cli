/**
 * Direct entrypoint for the spawned operator child process.
 *
 * `bin/robotnet-operator.js` re-exports this file (after the TypeScript
 * compile output lands in `dist/operator/main.js`). Tests fork the
 * `.ts` source directly via tsx.
 *
 * The split between this file and `index.ts` keeps the side-effecting
 * "call main()" out of the importable surface — `index.ts` only exports
 * functions, so test code can import `runOperatorMain` without
 * accidentally also starting a server.
 */
import { runOperatorMain } from "./index.js";

void runOperatorMain();
