// Parse the bundle patch with the YAML the Loader would use.
//
// A leading `@` is a reserved YAML indicator, so an unquoted scoped package
// name in `cordis.patch.yml` fails to parse — and the install then fails after
// pnpm has already succeeded. That is a cheap mistake to make and an expensive
// one to diagnose from a GUI, so the parse happens here on every test run.
//
// `js-yaml` and `yaml` are not dependencies of this plugin: it ships no runtime
// deps at all. The candidates are tried in order, and the check reports being
// skipped rather than failing when no parser is reachable from the caller.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchFile = join(root, "cordis.patch.yml");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * Load the first reachable YAML parser.
 *
 * `DSH_INSTALL_DIR` names the running CLI package (`.../node_modules/@deepseek-ai/dsh`),
 * so the Loader's own parser sits two levels up. Reading inside an `app.asar`
 * needs the DSH runtime, which runs this test through `npm test` under whatever
 * node is on PATH; the local anchor is tried first so the common case works.
 */
async function loadParser() {
  const install = process.env.DSH_INSTALL_DIR?.trim();
  const anchors = [{ dir: root, label: "local" }];
  if (install) {
    anchors.push({ dir: join(install, "..", ".."), label: "dsh" });
  }

  const load = async (entry) => import(new URL(`file:///${entry.replaceAll("\\", "/")}`).href);

  for (const specifier of ["js-yaml", "yaml"]) {
    for (const anchor of anchors) {
      try {
        const require = createRequire(join(anchor.dir, "package.json"));
        const module = await load(require.resolve(specifier));
        const parse = specifier === "js-yaml"
          ? (text) => (module.default ?? module).load(text)
          : (text) => (module.default ?? module).parse(text);
        return { parse, name: `${specifier} (${anchor.label})` };
      } catch {
        // Try the next anchor or the next parser.
      }
    }
  }
  return undefined;
}

const parser = await loadParser();
if (parser === undefined) {
  console.log("  skip  cordis.patch.yml parses (no YAML parser reachable)");
  console.log("\npatch checks skipped");
  process.exit(0);
}

const text = readFileSync(patchFile, "utf8");
let document;
try {
  document = parser.parse(text);
} catch (error) {
  console.error(`  FAIL  cordis.patch.yml parses :: ${error.message}`);
  console.error("\nA leading '@' must be quoted: name: '@scope/pkg'");
  process.exit(1);
}
console.log(`  ok    cordis.patch.yml parses (${parser.name})`);

const failures = [];
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok    ${label}`);
    return;
  }
  console.log(`  FAIL  ${label}`);
  failures.push(label);
};

check("the patch is a top-level array", Array.isArray(document));
const rows = (Array.isArray(document) ? document : []).flatMap((entry) => (
  Array.isArray(entry?.insert) ? entry.insert : []
));
check("it inserts at least one row", rows.length > 0);
check("every row names a plugin as a string", rows.every((row) => typeof row?.name === "string"));
check("every row has an id", rows.every((row) => typeof row?.id === "string" && row.id !== ""));
check(
  "the inserted row names this package",
  rows.some((row) => row.name === manifest.name),
);
check(
  "the manifest declares the same patch",
  manifest.dsh?.bundle?.patch === "./cordis.patch.yml",
);

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} patch check(s) failed`);
  process.exit(1);
}
console.log("\npatch checks passed");
