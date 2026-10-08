import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { nodeReporterUrl } from '../src/adapters/testing/docker-runner.js';
import { configSchema } from '../src/domain/config.js';
import { pipelineId } from '../src/domain/identity.js';
import { execute } from '../src/shared/process.js';

async function sourceFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}
test('source dependencies obey layer boundaries and contain no cycles', async () => {
  const root = resolve('src'), files = await sourceFiles(root);
  const graph = new Map<string, string[]>();
  const allowed: Record<string, string[]> = {
    domain: ['domain'], ports: ['domain', 'ports'], application: ['application', 'domain', 'ports', 'shared'],
    adapters: ['adapters', 'domain', 'ports', 'shared', 'reporting'],
    reporting: ['domain', 'reporting', 'shared'], shared: ['shared'],
    cli: ['cli', 'application', 'domain', 'ports', 'reporting', 'shared']
  };
  for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/'), layer = rel.split('/')[0]!;
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const dependencies: string[] = [];
    const visit = (node: ts.Node) => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (specifier?.startsWith('.')) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        assert.ok(files.includes(target), rel + ': unresolved ' + specifier);
        const targetLayer = relative(root, target).replaceAll('\\', '/').split('/')[0]!;
        const permitted = rel === 'cli.ts' ? ['cli'] : rel === 'cli/bootstrap.ts' ? [...allowed.cli!, 'adapters'] : allowed[layer]!;
        assert.ok(permitted.includes(targetLayer), rel + ' must not depend on ' + specifier);
        dependencies.push(target);
      } else if (specifier && ['domain', 'ports', 'application'].includes(layer)) {
        const pure = layer === 'domain' ? ['zod', 'typescript', 'node:crypto'] : layer === 'application' ? ['node:crypto', 'node:path'] : [];
        assert.ok(pure.includes(specifier), rel + ': external dependency ' + specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(source); graph.set(file, dependencies);
  }
  const visited = new Set<string>();
  const visit = (file: string, stack: string[]) => {
    assert.ok(!stack.includes(file), 'Dependency cycle: ' + [...stack, file].join(' -> '));
    if (visited.has(file)) return;
    for (const dependency of graph.get(file) ?? []) visit(dependency, [...stack, file]);
    visited.add(file);
  };
  for (const file of files) visit(file, []);
});
test('task identity stays compatible with the version-three report format', () => {
  assert.equal(pipelineId({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), description: 'change' },
    configSchema.parse({ repository: 'owner/repo' })), '758724df1a1758062dcef52e');
});
test('fresh build resolves CLI, Codex entry and reporter paths without old output files', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/build-')), out = join(root, 'dist');
  const build = await execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--outDir', out]);
  assert.equal(build.code, 0, build.stdout + build.stderr);
  const cli = await execute(process.execPath, [join(out, 'cli.js'), '--help']);
  assert.equal(cli.code, 0, cli.stderr); assert.match(cli.stdout, /tasks resume/);
  assert.match(cli.stdout, /repopilot serve/); assert.match(cli.stdout, /service approve/);
  const runnerUrl = pathToFileURL(join(out, 'adapters/testing/docker-runner.js')).href;
  const probe = await execute(process.execPath, ['--input-type=module', '-e',
    'import {nodeReporterUrl} from ' + JSON.stringify(runnerUrl) + '; console.log(nodeReporterUrl().href);']);
  assert.equal(probe.code, 0, probe.stderr);
  assert.equal(fileURLToPath(probe.stdout.trim()), join(out, 'adapters/testing/node-reporter.js'));
  assert.ok((await stat(fileURLToPath(probe.stdout.trim()))).isFile());
  assert.equal(fileURLToPath(nodeReporterUrl()), resolve('dist/adapters/testing/node-reporter.js'));
  const dockerfile = await readFile('Dockerfile.agent', 'utf8');
  assert.match(dockerfile, /dist\/adapters\/codex\/entry\.js/);
  assert.ok((await stat(join(out, 'adapters/codex/entry.js'))).isFile());
});
