import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const variants = [
  ["full", "pack/ot_survival_status/ot_survival_behavior", "pack/ot_survival_status/ot_survival_resource"],
  ["compat", "pack/ot_survival_status_compat/ot_survival_behavior_compat", "pack/ot_survival_status_compat/ot_survival_resource_compat"]
];
const root = fileURLToPath(new URL("../", import.meta.url));
const filesIn = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]);
const visit = (value, callback) => {
  callback(value);
  if (value && typeof value === "object")
    for (const child of Object.values(value)) visit(child, callback);
};

for (const [name, behaviorPath, resourcePath] of variants) {
  const behavior = resolve(root, behaviorPath);
  const resource = resolve(root, resourcePath);
  test(`${name}: all HUD gauges use one shared title cache, with no obsolete local data panels`, () => {
    const ui = JSON.parse(readFileSync(join(resource, "ui/hud_screen.json"), "utf8"));
    let retainedMessages = 0;
    visit(ui, (value) => {
      if (value?.binding_name_override === "#preserved_text") retainedMessages++;
    });
    assert.equal(retainedMessages, 1);
    assert.equal(ui.ot_position_data.bindings[1].binding_condition, "visibility_changed");
    for (const prefix of ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"]) {
      for (const entry of ui[`${prefix}_probe`].controls)
        assert.ok(!Object.keys(entry)[0].endsWith("_data"), "unused title caches must not return");
      visit(ui[`${prefix}_probe`], (value) => {
        if (value?.binding_type === "view") assert.equal(value.source_control_name, "ot_position_data");
      });
    }
  });

  test(`${name}: every shipped texture is referenced by UI or the item atlas`, () => {
    const references = new Set();
    for (const file of filesIn(resource).filter((file) => file.endsWith(".json")))
      visit(JSON.parse(readFileSync(file, "utf8")), (value) => {
        if (typeof value === "string" && value.startsWith("textures/")) references.add(value);
      });
    for (const file of filesIn(join(resource, "textures")).filter((file) => file.endsWith(".png"))) {
      const texture = relative(resource, file).replaceAll("\\", "/").replace(/\.png$/, "");
      assert.ok(references.has(texture), `unreferenced packaged texture: ${texture}`);
    }
  });

  test(`${name}: every shipped script is reachable from the manifest entry`, () => {
    const manifest = JSON.parse(readFileSync(join(behavior, "manifest.json"), "utf8"));
    const reachable = new Set();
    const walkImports = (file) => {
      file = resolve(file);
      if (reachable.has(file)) return;
      reachable.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bimport\s+(?:[^;\n]*?\bfrom\s+)?["'](\.[^"']+)["']/g))
        walkImports(resolve(file, "..", match[1]));
    };
    walkImports(join(behavior, manifest.modules.find((module) => module.type === "script").entry));
    assert.deepEqual([...reachable].sort(), filesIn(join(behavior, "scripts")).map((file) => resolve(file)).sort());
  });
}
