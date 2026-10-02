import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = (path) => read(path).replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");

test("standalone survival panel item and icon are packaged without the common add-on", () => {
  const item = JSON.parse(read("../pack/ot_survival_status/ot_survival_behavior/items/status_panel.json"))
    ["minecraft:item"];
  const textures = JSON.parse(read(
    "../pack/ot_survival_status/ot_survival_resource/textures/item_texture.json"));
  const manifest = JSON.parse(read("../pack/ot_survival_status/ot_survival_behavior/manifest.json"));
  assert.equal(item.description.identifier, "ot:status_panel");
  assert.ok(item.components["ot:status_panel_open"]);
  assert.equal(item.components["minecraft:icon"].textures.default, "ot_status_panel");
  assert.equal(textures.texture_data.ot_status_panel.textures, "textures/items/status_panel");
  assert.ok(existsSync(new URL(
    "../pack/ot_survival_status/ot_survival_resource/textures/items/status_panel.png", import.meta.url)));
  assert.ok(manifest.dependencies.some((dependency) => dependency.module_name === "@minecraft/server-ui" &&
    dependency.version === "2.2.0"));
  assert.match(read("../pack/ot_survival_status/ot_survival_behavior/scripts/main.js"),
    /import "\.\/status_panel\.js"/);
});

test("both variants craft one status panel from six dirt at a crafting table", () => {
  const paths = [
    "../pack/ot_survival_status/ot_survival_behavior",
    "../pack/ot_survival_status_compat/ot_survival_behavior_compat"
  ];
  const recipes = paths.map((path) => JSON.parse(read(`${path}/recipes/status_panel.json`)));
  assert.deepEqual(recipes[0], recipes[1], "both variants must have the same recipe");
  for (const [index, definition] of recipes.entries()) {
    assert.equal(definition.format_version, "1.20.10");
    const recipe = definition["minecraft:recipe_shaped"];
    assert.equal(recipe.description.identifier, "ot:status_panel");
    assert.deepEqual(recipe.tags, ["crafting_table"]);
    assert.deepEqual(recipe.pattern, ["DDD", "DDD"]);
    assert.equal(recipe.pattern.join("").length, 6);
    assert.deepEqual(recipe.key, { D: { item: "minecraft:dirt" } });
    const item = JSON.parse(read(`${paths[index]}/items/status_panel.json`))["minecraft:item"];
    assert.deepEqual(recipe.result, { item: item.description.identifier, count: 1 });
    assert.deepEqual(recipe.unlock, [{ item: "minecraft:dirt" }]);
  }
});

function harness() {
  let component;
  const forms = [];
  const messages = [];
  const scores = new Map();
  const properties = new Map([["ot:thirst_enabled", false]]);
  const writes = [];
  let objective;
  class ActionFormData {
    constructor() { this.buttons = []; }
    title(value) { this.heading = value; return this; }
    body(value) { this.description = value; return this; }
    button(label, icon) { this.buttons.push([label, icon]); return this; }
    show(player) { return new Promise((resolve) => forms.push({ kind: "action", form: this, player, resolve })); }
  }
  class ModalFormData {
    constructor() { this.toggles = []; this.sliders = []; }
    title(value) { this.heading = value; return this; }
    submitButton(value) { this.button = value; return this; }
    toggle(label, options) { this.toggles.push([label, options.defaultValue]); return this; }
    slider(label, min, max, options) { this.sliders.push([label, min, max, options]); return this; }
    show(player) { return new Promise((resolve) => forms.push({ kind: "modal", form: this, player, resolve })); }
  }
  const makePlayer = (id, permission) => {
    const saved = new Map();
    return { id, typeId: "minecraft:player", isValid: true, playerPermissionLevel: permission,
      saved, getDynamicProperty: (key) => saved.get(key),
      setDynamicProperty: (key, value) => saved.set(key, value),
      sendMessage: (message) => messages.push([id, message]) };
  };
  const player = makePlayer("admin", 2);
  const member = makePlayer("member", 1);
  const world = {
    scoreboard: {
      getObjective: () => objective,
      addObjective: () => (objective = {
        getScore(participant) {
          if (!scores.has(participant)) throw new Error(`Failed to resolve identity for '${participant}'.`);
          return scores.get(participant);
        },
        setScore(participant, value) { scores.set(participant, value); writes.push([participant, value]); }
      })
    },
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value),
    afterEvents: { playerLeave: { subscribe() {} } }
  };
  const system = { run: (callback) => callback(), beforeEvents: { startup: {
    subscribe: (callback) => callback({ itemComponentRegistry: {
      registerCustomComponent(id, value) { assert.equal(id, "ot:status_panel_open"); component = value; }
    } })
  } } };
  runInNewContext(`${script("../pack/ot_survival_status/ot_survival_behavior/scripts/status_flags.js")}
    ${script("../pack/ot_survival_status/ot_survival_behavior/scripts/hud_positions.js")}
    ${script("../pack/ot_survival_status/ot_survival_behavior/scripts/status_panel.js")}`,
  { world, system, ActionFormData, ModalFormData,
    PlayerPermissionLevel: { Operator: 2 }, console: { warn() {} } });
  return { component, forms, messages, scores, properties, writes, player, member };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("members adjust only their own HUD while equal icon-free operator buttons control global switches", async () => {
  const scene = harness();
  scene.component.onUse({ source: scene.member });
  assert.equal(scene.forms[0].kind, "modal");
  assert.equal(scene.forms[0].form.heading, "状态条位置（仅自己）");
  assert.equal(scene.forms[0].form.sliders.length, 6);
  assert.deepEqual(scene.forms[0].form.sliders.map((entry) => entry[3].defaultValue),
    [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(scene.forms[0].form.toggles, [["恢复默认位置（保存后生效）", false]]);
  scene.component.onUse({ source: scene.player });
  scene.component.onUseOn({ source: scene.player });
  assert.equal(scene.forms.length, 2);
  assert.equal(scene.forms[1].kind, "action");
  assert.deepEqual(scene.forms[1].form.buttons,
    [["状态条开关", undefined], ["调整我的状态条位置", undefined]]);
  assert.equal(scene.forms[1].form.description,
    "状态条开关：对全世界玩家生效。\n调整我的状态条位置：仅对自己生效。");
  assert.ok(scene.forms[0].form.sliders.every((entry, index) => entry[3].valueStep === 1 &&
    entry[1] === (index === 0 || index === 2 ? -100 : -75) && entry[2] === -entry[1]));
  scene.forms[0].resolve({ canceled: false, formValues: [-5, 5, 10, 0, -10, 5, false] });
  await flush();
  assert.equal(scene.member.saved.get("ot:hud_stamina_x"), -5);
  assert.equal(scene.member.saved.get("ot:hud_temperature_y"), -10);
  assert.equal(scene.properties.get("ot:stamina_enabled"), undefined);
  scene.forms[1].resolve({ canceled: false, selection: 0 });
  await flush();
  assert.equal(scene.forms.length, 3);
  assert.equal(scene.forms[2].form.heading, "状态条开关（全世界）");
  assert.deepEqual(scene.forms[2].form.toggles,
    [["体力", true], ["口渴", false], ["温度", true], ["理智", true]]);
  scene.forms[2].resolve({ canceled: false, formValues: [false, false, true, false] });
  await flush();
  assert.deepEqual(scene.writes, [["#stamina", 0], ["#sanity", 0]]);
  assert.equal(scene.properties.get("ot:stamina_enabled"), false);
  assert.equal(scene.properties.get("ot:sanity_enabled"), false);
  assert.match(scene.messages[0][1], /全世界玩家生效/);

  scene.scores.set("#thirst", 1); // A command-block change is visible on the next opening.
  scene.component.onUse({ source: scene.player });
  scene.forms[3].resolve({ canceled: false, selection: 0 });
  await flush();
  assert.deepEqual(scene.forms[4].form.toggles,
    [["体力", false], ["口渴", true], ["温度", true], ["理智", false]]);
  scene.forms[4].resolve({ canceled: true });
  await flush();
  assert.equal(scene.writes.length, 2);
});

test("losing operator permission while the panel is open cannot change global switches", async () => {
  const scene = harness();
  scene.component.onUse({ source: scene.player });
  scene.player.playerPermissionLevel = 1;
  scene.forms[0].resolve({ canceled: false, selection: 0 });
  await flush();
  assert.equal(scene.forms.length, 1);

  scene.player.playerPermissionLevel = 2;
  scene.component.onUse({ source: scene.player });
  scene.forms[1].resolve({ canceled: false, selection: 0 });
  await flush();
  scene.player.playerPermissionLevel = 1;
  scene.forms[2].resolve({ canceled: false, formValues: [false, false, false, false] });
  await flush();
  assert.equal(scene.writes.length, 0);
});

test("operator can save personal positions and members can reset their own without affecting anyone else", async () => {
  const scene = harness();
  scene.component.onUse({ source: scene.player });
  scene.forms[0].resolve({ canceled: false, selection: 1 });
  await flush();
  scene.forms[1].resolve({ canceled: false, formValues: [100, -75, -100, 75, 1, -1, false] });
  await flush();
  assert.equal(scene.player.saved.get("ot:hud_stamina_x"), 100);
  assert.equal(scene.player.saved.get("ot:hud_stamina_y"), -75);
  assert.equal(scene.player.saved.get("ot:hud_sanity_y"), 75);
  assert.equal(scene.player.saved.get("ot:hud_thirst_y"), -1);
  scene.member.saved.set("ot:hud_stamina_x", -10);
  scene.component.onUse({ source: scene.member });
  assert.equal(scene.forms[2].form.sliders[0][3].defaultValue, -10);
  scene.forms[2].resolve({ canceled: false, formValues: [0, 0, 0, 0, 0, 0, true] });
  await flush();
  assert.equal(scene.member.saved.get("ot:hud_stamina_x"), undefined);
  assert.equal(scene.player.saved.get("ot:hud_stamina_x"), 100);
  assert.equal(scene.writes.length, 0);
});

test("position modal fixes reset and green save outside the six-slider scrolling area in both packs", () => {
  const full = JSON.parse(read("../pack/ot_survival_status/ot_survival_resource/ui/server_form.json"));
  const compat = JSON.parse(read("../pack/ot_survival_status_compat/ot_survival_resource_compat/ui/server_form.json"));
  assert.deepEqual(full, compat);
  assert.equal(read("../pack/ot_survival_status/ot_survival_behavior/scripts/status_panel.js"),
    read("../pack/ot_survival_status_compat/ot_survival_behavior_compat/scripts/status_panel.js"));
  assert.equal(full["custom_form@common_dialogs.main_panel_no_buttons"].$child_control,
    "server_form.ot_survival_custom_form_router");
  assert.equal(full.custom_form_panel, undefined, "do not change the inherited native scrolling panel's type");
  const routes = full.ot_survival_custom_form_router.controls;
  assert.equal(routes[0]["ordinary@server_form.custom_form_panel"].bindings[1].source_property_name,
    "(not (#title_text = '状态条位置（仅自己）'))");
  assert.equal(routes[1]["positions@server_form.ot_survival_positions"].bindings[1].source_property_name,
    "(#title_text = '状态条位置（仅自己）')");
  const [scrolling, footer] = full.ot_survival_positions.controls;
  assert.deepEqual(Object.keys(footer), ["footer@server_form.ot_survival_position_footer"]);
  assert.deepEqual(scrolling["sliders@common.scrolling_panel"].size, ["100%", "100% - 76px"]);
  const sliders = full.ot_survival_position_sliders;
  assert.equal(sliders.collection_name, "custom_form");
  assert.deepEqual(sliders.controls.map((control) => Object.values(control)[0].collection_index), [0, 1, 2, 3, 4, 5]);
  assert.ok(sliders.controls.every((control) => Object.keys(control)[0].endsWith("@server_form.custom_slider")));
  const fixed = full.ot_survival_position_footer;
  assert.equal(fixed.anchor_from, "bottom_middle");
  assert.equal(fixed.anchor_to, "bottom_middle");
  assert.equal(fixed.collection_name, "custom_form");
  assert.deepEqual(fixed.size, ["100% - 8px", 72]);
  assert.equal(fixed.controls[0]["reset@server_form.custom_toggle"].collection_index, 6);
  const save = fixed.controls[2]["save@common_buttons.light_text_button"];
  assert.equal(save.$pressed_button_name, "button.submit_custom_form");
  assert.equal(save.$button_text, "#submit_text");
  assert.deepEqual(save.$button_image_color, [0.46, 0.85, 0.38]);
  assert.deepEqual(save.$default_text_color, [1, 1, 1]);
});
