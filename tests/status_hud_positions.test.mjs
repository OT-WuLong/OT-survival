import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countHudControl } from "../tools/inspect_status_hud_load.mjs";
import { HUD_SLIDERS, HUD_STEP, hudPositionMarkers, readHudPosition, saveHudPositions } from
  "../pack/ot_survival_status/ot_survival_behavior/scripts/hud_positions.js";

const readUi = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const modern = readUi("../pack/ot_survival_status/ot_survival_resource/ui/hud_screen.json");
const compat = readUi("../pack/ot_survival_status_compat/ot_survival_resource_compat/ui/hud_screen.json");
const choices = [-75, -15, -1, 0, 1, 15, 75];
const playerFixture = () => {
  const properties = new Map();
  return {
    properties,
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value)
  };
};

test("six saved positions encode small binary spacers and preserve existing player data", () => {
  const player = playerFixture();
  assert.equal(hudPositionMarkers(player), "");
  assert.equal(HUD_STEP, 1);
  assert.deepEqual(HUD_SLIDERS.map((slider) => slider.limit), [100, 75, 100, 75, 75, 75]);
  assert.equal(readFileSync(new URL("../pack/ot_survival_status/ot_survival_behavior/scripts/hud_positions.js", import.meta.url), "utf8"),
    readFileSync(new URL("../pack/ot_survival_status_compat/ot_survival_behavior_compat/scripts/hud_positions.js", import.meta.url), "utf8"));
  saveHudPositions(player, [15, -15, -15, 15, 5, -10]);
  assert.deepEqual(HUD_SLIDERS.map((slider) => readHudPosition(player, slider)),
    [15, -15, -15, 15, 5, -10]);
  assert.equal(hudPositionMarkers(player),
    "!A.0|!A.1|!A.2|!A.3|!B.-|!B.0|!B.1|!B.2|!B.3|!C.-|!C.0|!C.1|!C.2|!C.3|!D.0|!D.1|!D.2|!D.3|!E.0|!E.2|!F.-|!F.1|!F.3|");
  for (const values of [[101, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 76], [0.5, 0, 0, 0, 0, 0],
    [NaN, 0, 0, 0, 0, 0], [Infinity, 0, 0, 0, 0, 0], ["1", 0, 0, 0, 0, 0], [0]])
    assert.throws(() => saveHudPositions(player, values));
  assert.equal(player.properties.get("ot:hud_stamina_x"), 15, "invalid input must not partly overwrite saved offsets");
  player.properties.set("ot:hud_stamina_x", 32);
  assert.equal(readHudPosition(player, HUD_SLIDERS[0]), 32);
  saveHudPositions(player, [0, 0, 0, 0, 0, 0]);
  assert.equal(hudPositionMarkers(player), "");
  assert.equal(player.properties.get("ot:hud_stamina_x"), undefined);
});

const valueOf = (control) => Object.values(control)[0];

test("bars keep the proven vertical adjustment outside the fixed-height horizontal row", () => {
  // Structural regression based on the user's bar-vs-center comparison, not a renderer emulator.
  for (const ui of [modern, compat]) for (const prefix of ["ot_stamina", "ot_sanity"]) {
    const vertical = ui[`${prefix}_position`].controls[0].layout;
    assert.equal(vertical.orientation, "vertical", "vertical movement cannot live inside a 1px horizontal row");
    assert.deepEqual(vertical.size, [1, "100%c"]);
    const anchor = vertical.controls.find((entry) => entry.display_anchor).display_anchor;
    assert.equal(anchor.type, "panel", "a neutral panel separates the two stack axes");
    assert.deepEqual(anchor.size, [1, 1]);
    const horizontal = anchor.controls[0].horizontal;
    assert.equal(horizontal.orientation, "horizontal");
    assert.deepEqual(horizontal.size, ["100%c", 1]);
    assert.ok(horizontal.controls.every((entry) => Object.values(entry)[0].orientation !== "vertical"));
    const gaugeAnchor = horizontal.controls.find((entry) => entry.gauge_anchor).gauge_anchor;
    assert.deepEqual(gaugeAnchor.size, [1, 1]);
    assert.equal(gaugeAnchor.controls.length, 1);
    assert.deepEqual(vertical.controls.filter((entry) => Object.keys(entry)[0].startsWith("padding_")).map((entry) =>
      Object.keys(entry)[0].split("_")[1]), Array(14).fill(prefix === "ot_stamina" ? "B" : "D"));
  }
});

const isVisible = (panel, title, hud) => {
  const binding = panel.bindings?.find((entry) => entry.target_property_name === "#visible");
  if (!binding) return true;
  const expression = binding.source_property_name;
  if (expression === "(#hud_visible_not_centered or #hud_visible_centered_touch)")
    return hud.notCentered || hud.centeredTouch;
  const booleanExpression = expression
    .replace(/\bnot\b/g, "!").replace(/\bor\b/g, "||").replace(/\band\b/g, "&&")
    .replace(/(?<![=!<>])=(?!=)/g, "===")
    .replace(/\(#preserved_text - '([^']+)'\)/g, (_, marker) => JSON.stringify(title.replace(marker, "")))
    .replaceAll("#preserved_text", JSON.stringify(title));
  return Function(`return ${booleanExpression}`)();
};

test("zero position has no visible calibration padding or compensating layout offset", () => {
  // Structural guard for the reported default-position regression, not a client render test.
  for (const ui of [modern, compat]) for (const prefix of ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"]) {
    const layout = ui[`${prefix}_position`].controls[0].layout;
    assert.deepEqual(layout.offset ?? [0, 0], [0, 0], "zero must not depend on a large offset cancelling spacer heights");
    assert.equal(layout.anchor_from, "center");
    assert.equal(layout.anchor_to, "center");
    if (layout.orientation === "horizontal")
      assert.deepEqual(layout.size, ["100%c", 1], "horizontal sizing must not change the vertical baseline");
    const visit = (node) => {
      for (const entry of node.controls ?? []) {
        const [name, child] = Object.entries(entry)[0];
        if (name.startsWith("padding_"))
          assert.equal(isVisible(child, "OT_STATUS|S:96|T:96|C:2|M:96|", { notCentered: false, centeredTouch: false }), false,
            "zero must have no visible position spacer");
        if (!name.includes("@")) visit(child);
      }
    };
    visit(layout);
  }
});
// Model ordinary fixed offsets and visible stack children. This is a geometry
// check, not a replacement for Bedrock rendering on desktop/mobile clients.
const resolve = (ui, panel, title, desktop, hud = { notCentered: !desktop, centeredTouch: false }) => {
  const children = (node) => {
    const all = (node.controls ?? []).map((entry) => {
      const [name, local] = Object.entries(entry)[0];
      const reference = name.split("@")[1];
      return { name, node: reference ? { ...ui[reference.replace(/^hud\./, "")], ...local } : local };
    });
    return all.filter(({ node }) => isVisible(node, title, hud));
  };
  const measure = (node) => {
    // Artwork has a literal size and never contributes its nested pixels to position layout.
    if (node.size.every((size) => typeof size === "number")) return node.size;
    const sizes = children(node).map(({ node }) => measure(node));
    return node.size.map((size, axis) => {
      if (typeof size === "number") return size;
      assert.equal(size, "100%c", "position stacks must measure literal visible children");
      const along = node.orientation === (axis ? "vertical" : "horizontal");
      return along ? sizes.reduce((sum, value) => sum + value[axis], 0)
        : Math.max(0, ...sizes.map((value) => value[axis]));
    });
  };
  let result;
  const place = (node, rect, name) => {
    if (name?.startsWith("indicator@")) {
      assert.equal(result, undefined, "display must be instantiated once");
      result = [rect.x + rect.width / 2, rect.y + rect.height];
      return;
    }
    let cursor = 0;
    for (const child of children(node)) {
      const [width, height] = measure(child.node);
      let x = rect.x + (rect.width - width) / 2;
      let y = child.node.anchor_to === "center" ? rect.y + (rect.height - height) / 2
        : rect.y + rect.height - height;
      if (node.type === "stack_panel") {
        if (node.orientation === "horizontal") {
          x = rect.x + cursor;
          y = rect.y + (rect.height - height) / 2;
          cursor += width;
        } else {
          y = rect.y + cursor;
          cursor += height;
        }
      }
      const [dx, dy] = child.node.offset ?? [0, 0];
      assert.equal(typeof dx, "number");
      assert.equal(typeof dy, "number");
      place(child.node, { x: x + dx, y: y + dy, width, height }, child.name);
    }
  };
  const [x, y] = desktop && panel.variables ? panel.variables[0].$ot_base_offset : panel["$ot_base_offset|default"];
  const [width, height] = measure(panel);
  place(panel, { x: x - width / 2, y: y - height, width, height });
  assert.ok(result, "position tree must contain its display");
  return result;
};

test("HUD moves single displays using literal visible spacers, never numeric layout bindings", () => {
  assert.deepEqual(modern, compat);
  const ui = modern;
  assert.equal(ui.hotbar_start_cap, undefined);
  assert.equal(ui.hotbar_end_cap, undefined);
  assert.equal(ui.ot_thermal_probe.controls.length, 5, "texture rebuild must keep temperature separate");
  assert.equal(ui.ot_thirst_probe.controls.length, 97, "texture rebuild must not duplicate thirst rings");
  assert.equal(ui.ot_position_data.bindings[1].binding_name_override, "#preserved_text");
  assert.equal(ui.ot_position_data.bindings[1].binding_condition, "visibility_changed");
  for (const name of ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"]) {
    const indicator = ui[name + "_probe"];
    assert.equal(indicator.use_anchored_offset, undefined);
    assert.equal(indicator.property_bag, undefined);
    assert.deepEqual(indicator.offset, [0, 0]);
    assert.equal(indicator.allow_clipping, false);
    const position = ui[name + "_position"];
    assert.equal(position.bindings, undefined);
    assert.equal(position.offset, "$ot_base_offset");
    assert.equal(position.variables, undefined, "defaults must follow active native HUD bindings, not $desktop_screen");
    assert.equal(position.clips_children, false);
    assert.equal(position.controls.length, 1);
    let spacers = 0;
    const visit = (node) => {
      assert.equal(node.use_anchored_offset, undefined, "client rejected this numeric translation path");
      assert.equal(node.property_bag, undefined);
      assert.equal(node.clips_children, false);
      const native = node.bindings?.some((binding) => binding.binding_type === "global");
      for (const binding of node.bindings ?? []) {
        if (native) continue;
        assert.equal(binding.source_control_name, "ot_position_data");
        assert.equal(binding.target_property_name, "#visible");
        assert.ok(binding.source_property_name.includes("#preserved_text"));
      }
      if (node.bindings && !native) {
        spacers++;
        assert.ok(node.size.every((size) => Number.isInteger(size) && size > 0));
        assert.equal(node.controls, undefined, "only empty spacers may be repeated");
      }
      for (const entry of node.controls ?? [])
        if (!Object.keys(entry)[0].includes("@")) visit(valueOf(entry));
    };
    visit(position);
    assert.equal(spacers, name === "ot_stamina" || name === "ot_sanity" ? 28 : 14);
    for (const entry of indicator.controls)
      for (const binding of valueOf(entry).bindings ?? [])
        if (binding.binding_type === "view") assert.equal(binding.source_control_name, "ot_position_data");
  }
});

test("sampled saved pairs compute exactly the promised desktop and pocket offsets", () => {
  const player = playerFixture();
  for (const ui of [modern, compat]) {
    for (const desktop of [false, true]) {
      const base = desktop ? 95 : 105;
      const bottom = -1;
      for (const x of [-100, ...choices, 100]) for (const y of choices) {
        saveHudPositions(player, [x, y, x, y, y, y]);
        const title = "OT_STATUS|S:96|T:96|C:2|M:96|" + hudPositionMarkers(player);
        assert.deepEqual(resolve(ui, ui.ot_stamina_position, title, desktop), [-base + x, bottom + y]);
        assert.deepEqual(resolve(ui, ui.ot_sanity_position, title, desktop), [base + x, bottom + y]);
        assert.deepEqual(resolve(ui, ui.ot_thermal_position, title, desktop), [0, -32 + y]);
        assert.deepEqual(resolve(ui, ui.ot_thirst_position, title, desktop), [0, -32 + y]);
      }
    }
  }
  // Saving one slider cannot move the other indicators, even at the same textual value.
  saveHudPositions(player, [15, -15, -15, 15, 5, -10]);
  const title = "OT_STATUS|" + hudPositionMarkers(player);
  assert.deepEqual(resolve(modern, modern.ot_stamina_position, title, true), [-80, -16]);
  assert.deepEqual(resolve(modern, modern.ot_sanity_position, title, true), [80, 14]);
  assert.deepEqual(resolve(modern, modern.ot_thermal_position, title, true), [0, -27]);
  assert.deepEqual(resolve(modern, modern.ot_thirst_position, title, true), [0, -42]);
  saveHudPositions(player, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(resolve(modern, modern.ot_stamina_position, "OT_STATUS|", true), [-95, -1]);
  assert.deepEqual(resolve(modern, modern.ot_sanity_position, "OT_STATUS|", true), [95, -1]);
  assert.deepEqual(resolve(modern, modern.ot_thermal_position, "OT_STATUS|", true), [0, -32]);
});

test("Pocket and centered-touch HUDs choose mobile spacing even with classic UI variables", () => {
  for (const ui of [modern, compat]) {
    for (const hud of [
      { notCentered: true, centeredTouch: false },
      { notCentered: false, centeredTouch: true },
      { notCentered: true, centeredTouch: true }
    ]) {
      assert.deepEqual(resolve(ui, ui.ot_stamina_position, "OT_STATUS|", true, hud), [-105, -1]);
      assert.deepEqual(resolve(ui, ui.ot_sanity_position, "OT_STATUS|", true, hud), [105, -1]);
      assert.deepEqual(resolve(ui, ui.ot_thermal_position, "OT_STATUS|", true, hud), [0, -32]);
      assert.deepEqual(resolve(ui, ui.ot_thirst_position, "OT_STATUS|", true, hud), [0, -32]);
    }
    const keyboardHud = { notCentered: false, centeredTouch: false };
    assert.deepEqual(resolve(ui, ui.ot_stamina_position, "OT_STATUS|", false, keyboardHud), [-95, -1]);
    assert.deepEqual(resolve(ui, ui.ot_sanity_position, "OT_STATUS|", false, keyboardHud), [95, -1]);
  }
});

test("mobile default spacer reads native HUD state without repeating artwork", () => {
  for (const ui of [modern, compat]) for (const prefix of ["ot_stamina", "ot_sanity"]) {
    const vertical = ui[`${prefix}_position`].controls[0].layout;
    const controls = vertical.controls.find((entry) => entry.display_anchor).display_anchor.controls[0].horizontal.controls;
    const padding = controls.find((entry) => entry.mobile_padding)?.mobile_padding;
    assert.ok(padding);
    assert.deepEqual(padding.size, [20, 1]);
    assert.equal(padding.controls, undefined);
    assert.deepEqual(padding.bindings, [
      { binding_type: "global", binding_name: "#hud_visible_not_centered" },
      { binding_type: "global", binding_name: "#hud_visible_centered_touch" },
      { binding_type: "view", source_property_name: "(#hud_visible_not_centered or #hud_visible_centered_touch)",
        target_property_name: "#visible" }
    ]);
    const names = controls.map((entry) => Object.keys(entry)[0]);
    assert.equal(names.indexOf("mobile_padding") < names.indexOf("gauge_anchor"), prefix === "ot_sanity",
      "extra padding must push stamina left and sanity right");
  }
});

test("positioning repeats only lightweight spacers, never copies the display per slider combination", () => {
  for (const ui of [modern, compat]) {
    let nodes = 0;
    for (const prefix of ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"]) {
      const single = countHudControl(ui, ui[`${prefix}_probe`]);
      const positioned = countHudControl(ui, ui[`${prefix}_position`]);
      assert.ok(positioned.nodes <= single.nodes + 34);
      assert.ok(positioned.bindings <= single.bindings + 31);
      nodes += positioned.nodes;
    }
    assert.ok(nodes < 1300, `positioned HUD expanded to ${nodes} nodes`);
  }
});

test("changing stamina does not change any computed position", () => {
  const player = playerFixture();
  saveHudPositions(player, [-15, 10, 5, -5, 15, -10]);
  for (const prefix of ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"]) {
    const panel = modern[`${prefix}_position`];
    const expected = resolve(modern, panel, "OT_STATUS|" + hudPositionMarkers(player), true);
    for (let stamina = 0; stamina <= 96; stamina++)
      assert.deepEqual(resolve(modern, panel, `OT_STATUS|S:${stamina}|T:1|C:2|M:96|` + hudPositionMarkers(player), true), expected);
  }
});

test("saving any one slider moves only its own axis and display", () => {
  const player = playerFixture();
  const prefixes = ["ot_stamina", "ot_sanity", "ot_thermal", "ot_thirst"];
  const targets = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 1], [3, 1]];
  for (const ui of [modern, compat]) for (const desktop of [true, false]) {
    const defaults = prefixes.map((prefix) => resolve(ui, ui[`${prefix}_position`], "OT_STATUS|", desktop));
    for (let slider = 0; slider < HUD_SLIDERS.length; slider++)
      for (let step = -HUD_SLIDERS[slider].limit; step <= HUD_SLIDERS[slider].limit; step++) {
      const values = HUD_SLIDERS.map(() => 0);
      values[slider] = step;
      saveHudPositions(player, values);
      const title = "OT_STATUS|S:48|T:48|C:2|M:48|" + hudPositionMarkers(player);
      const expected = defaults.map((point) => [...point]);
      const [display, axis] = targets[slider];
      expected[display][axis] += step;
      assert.deepEqual(prefixes.map((prefix) => resolve(ui, ui[`${prefix}_position`], title, desktop)), expected);
    }
  }
});
