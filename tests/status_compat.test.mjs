import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = "../pack/ot_survival_status_compat/";
const read = (path) => readFileSync(new URL(root + path, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

test("compatibility pack is separate from the untouched full pack", () => {
  const behavior = json("ot_survival_behavior_compat/manifest.json");
  const resource = json("ot_survival_resource_compat/manifest.json");
  const fullBehavior = JSON.parse(readFileSync(new URL(
    "../pack/ot_survival_status/ot_survival_behavior/manifest.json", import.meta.url)));
  const fullResource = JSON.parse(readFileSync(new URL(
    "../pack/ot_survival_status/ot_survival_resource/manifest.json", import.meta.url)));
  assert.deepEqual(behavior.header.min_engine_version, [1, 21, 120]);
  assert.deepEqual(resource.header.min_engine_version, [1, 21, 120]);
  assert.notEqual(behavior.header.uuid, fullBehavior.header.uuid);
  assert.notEqual(resource.header.uuid, fullResource.header.uuid);
  assert.deepEqual(behavior.dependencies.map((dependency) => dependency.version),
    ["2.3.0", "2.0.0", resource.header.version]);
  assert.equal(behavior.dependencies[2].uuid, resource.header.uuid);
  assert.equal(resource.dependencies[0].uuid, behavior.header.uuid);
  assert.deepEqual(fullBehavior.header.min_engine_version, [1, 26, 50]);
  assert.equal(fullBehavior.dependencies[0].version, "2.10.0");
  assert.deepEqual(behavior.header.version, resource.header.version);
  assert.deepEqual(fullBehavior.header.version, fullResource.header.version);
  for (const pack of [behavior, resource, fullBehavior, fullResource]) {
    for (const module of pack.modules)
      assert.deepEqual(module.version, pack.header.version);
    for (const dependency of pack.dependencies.filter((entry) => entry.uuid))
      assert.deepEqual(dependency.version, pack.header.version);
  }
  assert.equal(json("ot_survival_behavior_compat/items/status_panel.json").format_version,
    "1.21.120");
});

test("API 2.3 loads without newer swing, mining-start or hurt-before events", () => {
  const source = read("ot_survival_behavior_compat/scripts/stamina_probe/index.js")
    .replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");
  const callbacks = {};
  const warnings = [];
  const signal = (name) => ({ subscribe(callback) { callbacks[name] = callback; } });
  const properties = new Map();
  const player = {
    id: "player-1", typeId: "minecraft:player", isValid: true,
    isOnGround: true, isJumping: false, isSprinting: false, isSwimming: false,
    isInWater: false, isGliding: false, isSneaking: false,
    getGameMode: () => "survival",
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value),
    inputPermissions: { isPermissionCategoryEnabled: () => true, setPermissionCategory() {} },
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    getHeadLocation: () => ({ x: 0, y: 64, z: 0 }),
    dimension: { id: "minecraft:overworld" },
    onScreenDisplay: { setTitle() {} },
    addEffect() {}, applyDamage: () => true, runCommand: () => ({ successCount: 1 }),
    sendMessage() {}
  };
  const afterNames = ["entityHitEntity", "entityHurt", "playerBreakBlock", "itemStartUse",
    "itemStopUse", "itemReleaseUse", "playerHotbarSelectedSlotChange", "itemCompleteUse",
    "playerSpawn", "playerLeave"];
  const afterEvents = Object.fromEntries(afterNames.map((name) => [name, signal(name)]));
  const sandbox = {
    GameMode: { Survival: "survival", Adventure: "adventure" },
    InputPermissionCategory: { Jump: "Jump" },
    PlayerPermissionLevel: { Operator: 2 },
    statusEnabled: () => true, setStatusEnabled() {}, legacyScore: () => undefined,
    hudPositionMarkers: () => "",
    system: { currentTick: 10, runInterval() {}, run() {},
      afterEvents: { scriptEventReceive: signal("scriptEventReceive") } },
    world: { getAllPlayers: () => [player], getDynamicProperty: () => undefined, afterEvents,
      beforeEvents: { playerBreakBlock: signal("beforeBreak"), itemUse: signal("beforeUse") } },
    console: { warn: (message) => warnings.push(message) }
  };
  runInNewContext(`${source}\nglobalThis.compatState = stateFor;`, sandbox);
  const state = sandbox.compatState(player);
  const zombie = { id: "zombie-1", typeId: "minecraft:zombie" };
  callbacks.entityHitEntity({ damagingEntity: player, hitEntity: zombie });
  assert.equal(state.value, 98);
  assert.equal(state.recoveryBlockedTicks, 10);
  callbacks.entityHurt({ hurtEntity: zombie, damage: 2,
    damageSource: { cause: "entityAttack", damagingEntity: player } });
  assert.equal(state.value, 98, "one hit must not be charged twice");
  callbacks.playerBreakBlock({ player });
  assert.equal(state.value, 97, "a completed block break keeps the minimum cost");
  for (const effect of ["minecraft:water", "minecraft:healing", "minecraft:awkward"]) {
    state.thirst = 50;
    callbacks.itemCompleteUse({ source: player, itemStack: {
      typeId: "minecraft:potion",
      getComponent() { throw new Error("potion contents unavailable in API 2.3"); }
    } });
    assert.equal(state.thirst, 70, `${effect}: old API uses the shared twenty-point gain`);
  }
  state.thirst = 95;
  callbacks.itemCompleteUse({ source: player, itemStack: { typeId: "minecraft:potion" } });
  assert.equal(state.thirst, 100, "potion hydration remains capped at 100");
  for (const [typeId, gain] of [
    ["minecraft:milk_bucket", 20], ["minecraft:mushroom_stew", 10],
    ["minecraft:rabbit_stew", 10], ["minecraft:beetroot_soup", 10],
    ["minecraft:suspicious_stew", 10], ["minecraft:honey_bottle", 0],
    ["minecraft:splash_potion", 0], ["minecraft:lingering_potion", 0]
  ]) {
    state.thirst = 50;
    callbacks.itemCompleteUse({ source: player, itemStack: { typeId } });
    assert.equal(state.thirst, 50 + gain, `${typeId}: other drink gains must not change`);
  }
  assert.deepEqual(warnings, [], "drink processing must complete without swallowed errors");
});

test("compatibility temperature still counts completed mining and confirmed melee heat", () => {
  const source = read("ot_survival_behavior_compat/scripts/temperature/index.js")
    .replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");
  const callbacks = {};
  const signal = (name) => ({ subscribe(callback) { callbacks[name] = callback; } });
  const properties = new Map();
  const player = {
    id: "player-1", typeId: "minecraft:player", getGameMode: () => "survival",
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value)
  };
  const afterNames = ["weatherChange", "itemCompleteUse", "playerBreakBlock",
    "entityHitEntity", "playerSpawn", "playerLeave"];
  const sandbox = {
    EntityDamageCause: { temperature: "temperature" },
    EquipmentSlot: { Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet" },
    GameMode: { Survival: "survival", Adventure: "adventure" },
    PlayerPermissionLevel: { Operator: 2 },
    statusEnabled: () => true, setStatusEnabled() {}, legacyScore: () => undefined,
    system: { runInterval() {}, run() {},
      afterEvents: { scriptEventReceive: signal("scriptEventReceive") } },
    world: { afterEvents: Object.fromEntries(afterNames.map((name) => [name, signal(name)])) },
    console: { warn() {} }
  };
  runInNewContext(`${source}\nglobalThis.compatState = stateFor;`, sandbox);
  callbacks.playerBreakBlock({ player });
  callbacks.entityHitEntity({ damagingEntity: player });
  assert.equal(sandbox.compatState(player).activity, 4);
  for (const typeId of ["minecraft:mushroom_stew", "minecraft:rabbit_stew",
    "minecraft:beetroot_soup", "minecraft:suspicious_stew"]) {
    sandbox.compatState(player).value = 40;
    callbacks.itemCompleteUse({ source: player, itemStack: { typeId } });
    assert.equal(sandbox.compatState(player).value, 48, `${typeId}: stew warming stays at eight`);
  }
});
