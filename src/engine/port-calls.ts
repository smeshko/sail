// A script step's literal `sail port <name>` calls, checked against the ports the step names.
//
// A call is `sail port <name>` in shell, or `'port', '<name>'` in a JavaScript argument array, on a line that isn't a
// comment (`#`, `//`, `/*`, `*`). `sail port render` is no call, and a name that is no variable (`"$P"`, `${P}`,
// `...args`) is dynamic: skipped here, and left to the runtime message that names the fix.
//
// A step is checked with its `run` file and every file the reader reaches from it. The definition folder's own
// top-level script files, which no step reaches, are checked against the union of its steps' ports: top-level only,
// because an intake's folder is its workflow's folder, which holds every private stage.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { SCRIPT_PORTS } from '../kinds/script';
import type { DefinitionProblem, Definitions, ScriptRef } from './definitions';
import { reachFiles } from './references';

const SHELL_CALL = /\bsail\s+port\s+([a-z][a-z-]*)\b/;
const JS_CALL = /['"]port['"]\s*,\s*['"]([a-z][a-z-]*)['"]/;
const COMMENT = /^\s*(?:#|\/\/|\/\*|\*)/;
const SCRIPT_FILE = /\.(?:sh|mjs|js|cjs|ts)$/;
const DEFINITION_FILES = new Set(['stage.ts', 'intake.ts', 'workflow.ts', 'schemas.ts']);
const PORTS = Object.keys(SCRIPT_PORTS);

interface Call {
  port: string;
  file: string;
  line: number;
}

function callsIn(file: string): Call[] {
  const calls: Call[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (COMMENT.test(text)) return;
      const port = (SHELL_CALL.exec(text) ?? JS_CALL.exec(text))?.[1];
      if (port !== undefined && port !== 'render') calls.push({ port, file, line: i + 1 });
    });
  return calls;
}

export function portCallProblems(
  sailDir: string,
  definitions: Pick<Definitions, 'stages' | 'intakes'>,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const at = (call: Call) => `${relative(sailDir, call.file)}:${call.line}`;

  for (const entry of [...definitions.stages, ...definitions.intakes]) {
    if (entry.scripts.length === 0) continue;
    const reached = new Set<string>();

    for (const script of entry.scripts) {
      if (!existsSync(script.run)) continue;
      const reach = reachFiles([script.run], sailDir);
      problems.push(...reach.problems);
      for (const file of reach.files) reached.add(file);
      const reported = new Set<string>();
      for (const call of reach.files.flatMap(callsIn)) {
        if (reported.has(call.port)) continue;
        if (!PORTS.includes(call.port)) {
          reported.add(call.port);
          const message = `step ${script.step} calls sail port ${call.port} at ${at(call)}, which is no port: ticket-source, codehost or jev`;
          problems.push({ file: entry.file, message });
        } else if (!script.ports.includes(call.port)) {
          reported.add(call.port);
          const message = `step ${script.step} calls sail port ${call.port} at ${at(call)}, and its ports don't name it: add '${call.port}' to its ports`;
          problems.push({ file: entry.file, message });
        }
      }
    }

    problems.push(...folderProblems(sailDir, entry, reached, at));
  }
  return problems;
}

function folderProblems(
  sailDir: string,
  entry: { name: string; file: string; scripts: ScriptRef[] },
  reached: Set<string>,
  at: (call: Call) => string,
): DefinitionProblem[] {
  const folder = dirname(entry.file);
  const named = new Set(entry.scripts.flatMap((script) => script.ports));
  const files = readdirSync(folder, { withFileTypes: true })
    .filter((f) => f.isFile() && SCRIPT_FILE.test(f.name) && !DEFINITION_FILES.has(f.name))
    .map((f) => join(folder, f.name))
    .filter((file) => !reached.has(file))
    .sort();
  const reach = reachFiles(files, sailDir);
  const problems = [...reach.problems];
  const reported = new Set<string>();
  for (const call of reach.files.filter((file) => !reached.has(file)).flatMap(callsIn)) {
    if (reported.has(call.port) || named.has(call.port)) continue;
    reported.add(call.port);
    const what = PORTS.includes(call.port) ? '' : ' (no port)';
    problems.push({
      file: entry.file,
      message: `${at(call)} calls sail port ${call.port}${what}, and no script step of ${entry.name} names it in its ports`,
    });
  }
  return problems;
}
