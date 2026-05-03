// T8.2 ESLint backstop fixture (b) — renamed named import.
// no-restricted-imports.importNames matches the original specifier name,
// not the local alias, so this still trips. Grep in tools/lint-no-ipc.sh
// would also catch this (the substring `ipcRenderer` is present), but the
// AST rule matters when someone reaches for evasion (c)-(f) below.
import { ipcRenderer as foo } from 'electron';

export const _trip = foo;
