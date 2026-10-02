import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Structural work count, not a measurement of Minecraft's frame time.
export function countHudControl(ui, panel) {
  let nodes = 1;
  let bindings = panel.bindings?.length ?? 0;
  for (const entry of panel.controls ?? []) {
    const [name, local] = Object.entries(entry)[0];
    const reference = name.split('@')[1];
    const child = reference ? { ...ui[reference.replace(/^hud\./, '')], ...local } : local;
    const result = countHudControl(ui, child);
    nodes += result.nodes;
    bindings += result.bindings;
  }
  return { nodes, bindings };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ui = JSON.parse(readFileSync(process.argv[2] ??
    new URL('../pack/ot_survival_status/ot_survival_resource/ui/hud_screen.json', import.meta.url), 'utf8'));
  for (const prefix of ['ot_stamina', 'ot_sanity', 'ot_thermal', 'ot_thirst']) {
    const single = countHudControl(ui, ui[`${prefix}_probe`]);
    const positioned = countHudControl(ui, ui[`${prefix}_position`]);
    console.log(JSON.stringify({ indicator: prefix, single, positioned }));
  }
}
