import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const flagsScript = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/status_flags.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^export /gm, "");
const script = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/temperature/index.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^import \{[^\n]+\} from "\.\.\/status_flags\.js";\s*/, "")
  .replace(/^export /gm, "");
const compatScript = readFileSync(new URL(
  "../pack/ot_survival_status_compat/ot_survival_behavior_compat/scripts/temperature/index.js", import.meta.url), "utf8")
  .replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");

function armorItem(typeId, level = 0) {
  return { typeId, getComponent: (id) => id === "minecraft:enchantable"
    ? { getEnchantment: (name) => {
      assert.equal(name, "fire_protection");
      return level ? { level } : undefined;
    } } : undefined };
}

function harness(legacyScore, implementation = script) {
  let onTick, onSample, onCommand, onWeather, onSpawn, onLeave;
  let onSwing, onStartMining, onStopMining, onConsume;
  const properties = new Map();
  const worldProperties = new Map();
  const scores = new Map();
  const messages = [];
  const commands = [];
  const damage = [];
  const warnings = [];
  let objective;
  let flagsObjective;
  let time = 13000;
  let biome = "minecraft:plains";
  let heatBlock;
  let heatY = 64;
  let heatX = 1;
  let heatZ = 0;
  let footingBlock;
  let roof = false;
  let hunger = 20;
  let onFire = false;
  let velocity = { x: 0, y: 0, z: 0 };
  const armor = new Set();
  const equipment = new Map();
  const effects = new Map();
  const blocks = new Map();
  const player = {
    id: "player-1", typeId: "minecraft:player", playerPermissionLevel: 2, armorQueries: 0,
    mode: "survival", location: { x: 0, y: 64, z: 0 }, isInWater: false, isSprinting: false,
    isSwimming: false, isJumping: false,
    getGameMode() { return this.mode; },
    getHeadLocation() { return { x: 0, y: 65, z: 0 }; },
    getAABB() { return { center: { x: this.location.x, y: this.location.y + 0.9, z: this.location.z },
      extent: { x: 0.3, y: 0.9, z: 0.3 } }; },
    getVelocity: () => velocity,
    getEffect: (id) => effects.get(id),
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value),
    getComponent: (id) => id === "minecraft:equippable"
      ? { getEquipment: (slot) => {
        player.armorQueries++;
        return equipment.get(slot) ?? (armor.has(slot)
          ? { typeId: "minecraft:leather_boots", getComponent: () => undefined } : undefined);
      } }
      : id === "minecraft:player.hunger" ? { currentValue: hunger }
        : id === "minecraft:onfire" && onFire ? { onFireTicksRemaining: 20 } : undefined,
    runCommand(command) {
      assert.match(command, /^scoreboard players set @s ot_temperature \d+$/);
      if (!objective) return { successCount: 0 };
      scores.set(this.id, Number(command.split(" ").at(-1)));
      commands.push(command);
      return { successCount: 1 };
    },
    sendMessage: (message) => messages.push(message),
    applyDamage: (amount, options) => { damage.push({ amount, cause: options?.cause }); return true; },
    dimension: {
      id: "minecraft:overworld",
      heightRange: { min: -64, max: 320 },
      getBiome: () => ({ id: biome }),
      getTopmostBlock: () => ({ location: { y: roof ? 66 : 63 } }),
      getSkyLightLevel: () => 15,
      getBlock: ({ x, y, z }) => ({ typeId: blocks.get(`${x},${y},${z}`)
        ?? (x === 0 && y === 64 && z === 1 ? "minecraft:stone"
        : heatBlock && x === heatX && y === heatY && z === heatZ
        ? heatBlock : footingBlock && x === 0 && y === 63 && z === 0
          ? footingBlock : "minecraft:air") })
    }
  };
  if (implementation === compatScript) delete player.getAABB; // API 2.3 has no collision-bounds method.
  const signal = (save) => ({ subscribe: (callback) => save(callback) });
  const sandbox = {
    EquipmentSlot: { Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet" },
    GameMode: { Survival: "survival", Adventure: "adventure" },
    PlayerPermissionLevel: { Operator: 2 },
    EntityDamageCause: { temperature: "temperature" },
    console: { warn: (message) => warnings.push(message) },
    system: {
      runInterval: (callback, interval) => {
        if (interval === 20) onTick = callback;
        else if (interval === 1) onSample = callback;
        else assert.fail(`unexpected interval ${interval}`);
      },
      run: (callback) => callback(),
      afterEvents: { scriptEventReceive: signal((callback) => { onCommand = callback; }) }
    },
    world: {
      getDynamicProperty: (key) => worldProperties.get(key),
      setDynamicProperty: (key, value) => worldProperties.set(key, value),
      getTimeOfDay: () => time,
      getAllPlayers: () => [player],
      scoreboard: {
        getObjective: (id) => id === "ot_status_flags" ? flagsObjective : objective,
        addObjective: (id) => {
          if (id === "ot_status_flags") {
            const flags = new Map();
            flagsObjective = { id, getScore: (participant) => flags.get(participant.id ?? participant),
              setScore: (participant, value) => flags.set(participant.id ?? participant, value) };
            return flagsObjective;
          }
          objective = { id, getScore: (participant) => scores.get(participant.id ?? participant) };
          return objective;
        }
      },
      afterEvents: {
        weatherChange: signal((callback) => { onWeather = callback; }),
        playerSpawn: signal((callback) => { onSpawn = callback; }),
        playerLeave: signal((callback) => { onLeave = callback; }),
        playerSwingStart: signal((callback) => { onSwing = callback; }),
        entityHitEntity: signal(() => {}),
        playerStartBreakingBlock: signal((callback) => { onStartMining = callback; }),
        playerCancelBreakingBlock: signal((callback) => { onStopMining = callback; }),
        playerBreakBlock: signal((callback) => { onStopMining = callback; }),
        itemCompleteUse: signal((callback) => { onConsume = callback; })
      }
    }
  };
  if (legacyScore !== undefined) {
    scores.set(player.id, legacyScore);
    objective = { id: "ot_temperature", getScore: (participant) => scores.get(participant.id ?? participant) };
  }
  runInNewContext(`${flagsScript}\n${implementation}\nglobalThis.testApi = { rawTier, tierFor, environment, stateFor, temperatureEnabled, setTemperatureEnabled, COLD_BIOMES, HOT_BIOMES };`, sandbox);
  return {
    player, properties, worldProperties, scores, commands, messages, damage, warnings, armor, effects, equipment,
    ...sandbox.testApi,
    tick: (count = 1) => { for (let i = 0; i < count; i++) {
      for (let j = 0; j < 20; j++) onSample?.();
      onTick();
    } },
    sample: (count = 1) => { for (let i = 0; i < count; i++) onSample?.(); },
    swing: () => onSwing?.({ player, swingSource: "Attack" }),
    mine: () => onStartMining?.({ player, block: { dimension: player.dimension,
      location: { x: 0, y: 64, z: 1 }, typeId: "minecraft:stone" } }),
    stopMine: () => onStopMining?.({ player, block: { location: { x: 0, y: 64, z: 1 } } }),
    consume: (typeId) => onConsume?.({ source: player, itemStack: { typeId } }),
    command: (message) => onCommand({ id: "ot:temperature_test", message, sourceEntity: player }),
    weather: (newWeather) => onWeather({ dimension: "minecraft:overworld", newWeather }),
    respawn: () => onSpawn({ player, initialSpawn: false }),
    leave: () => onLeave({ playerId: player.id }),
    setBiome: (value) => { biome = value; },
    setTime: (value) => { time = value; },
    setHeat: (value, y = 64, x = 1, z = 0) => { heatBlock = value; heatY = y; heatX = x; heatZ = z; },
    setFooting: (value) => { footingBlock = value; },
    setRoof: (value) => { roof = value; },
    setHunger: (value) => { hunger = value; },
    setOnFire: (value) => { onFire = value; },
    setVelocity: (value) => { velocity = value; },
    setBlock: (x, y, z, typeId) => { blocks.set(`${x},${y},${z}`, typeId); },
    removeObjective: () => { objective = undefined; }
  };
}

test("old world temperature score seeds the independent pack", () => {
  const scene = harness(72);
  assert.equal(scene.stateFor(scene.player).value, 72);
  assert.equal(scene.properties.get("ot:temperature_value"), 72);
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
test(`${edition}: worn fire-protection levels add to a capped heat reduction`, () => {
  const scene = harness(undefined, implementation);
  scene.setHeat("minecraft:fire");
  scene.equipment.set("Chest", armorItem("minecraft:iron_chestplate", 4));
  assert.equal(scene.environment(scene.player).target, 66, "one Fire Protection IV removes twenty percent of hot-source heat");
  scene.equipment.set("Head", armorItem("minecraft:iron_helmet", 1));
  scene.equipment.set("Legs", armorItem("minecraft:iron_leggings", 2));
  scene.equipment.set("Feet", armorItem("minecraft:iron_boots", 3));
  assert.equal(scene.environment(scene.player).target, 60, "ten total levels remove fifty percent");
  for (const [slot, part] of [["Head", "helmet"], ["Chest", "chestplate"], ["Legs", "leggings"], ["Feet", "boots"]])
    scene.equipment.set(slot, armorItem(`minecraft:iron_${part}`, 4));
  assert.equal(scene.environment(scene.player).target, 54, "sixteen total levels cap at eighty percent");
  scene.setHeat("minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 56);
  scene.equipment.set("Head", armorItem("minecraft:iron_helmet", 100));
  assert.equal(scene.environment(scene.player).target, 56, "oversized custom levels cannot bypass the cap");
  scene.equipment.clear();
  scene.equipment.set("Chest", armorItem("minecraft:iron_chestplate", NaN));
  assert.equal(scene.environment(scene.player).target, 80, "invalid levels grant no insulation");
});

test(`${edition}: fire protection does not lower biome heat or weaken useful cold-weather warming`, () => {
  const scene = harness(undefined, implementation);
  for (const [slot, part] of [["Head", "helmet"], ["Chest", "chestplate"], ["Legs", "leggings"], ["Feet", "boots"]])
    scene.equipment.set(slot, armorItem(`minecraft:iron_${part}`, 4));
  scene.player.dimension.id = "minecraft:nether";
  assert.equal(scene.environment(scene.player).target, 85, "no source means no biome deduction");
  scene.setHeat("minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 91, "only thirty points of source heat are reduced");
  scene.effects.set("minecraft:fire_resistance", { amplifier: 0 });
  assert.equal(scene.environment(scene.player).target, 71, "potion insulation applies after enchantment protection");
  scene.effects.delete("minecraft:fire_resistance");
  scene.player.dimension.id = "minecraft:overworld";
  scene.setHeat(undefined);
  scene.setBiome("minecraft:ice_plains");
  scene.setTime(6000);
  scene.setRoof(true);
  scene.setHeat("minecraft:fire");
  assert.equal(scene.environment(scene.player).target, 45, "warming that stays below fifty is untouched");
  scene.setHeat("minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 51, "only the five points above fifty are reduced");
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 35, "cold-water warmth below fifty is preserved");
  scene.player.isInWater = false;
  scene.setBiome("minecraft:plains");
  scene.setHeat(undefined);
  scene.setOnFire(true);
  const burning = scene.environment(scene.player);
  assert.equal(burning.target, 54, "body fire is also a heat source");
  assert.equal(burning.warmingRate, 3, "enchantment does not override the existing burning-rate multiplier");
  assert.equal(burning.dryingFast, true);
});

test(`${edition}: fire protection reads only worn equipment once per temperature update and follows removal`, () => {
  const scene = harness(undefined, implementation);
  scene.setHeat("minecraft:fire");
  scene.equipment.set("Offhand", armorItem("minecraft:iron_chestplate", 4));
  scene.equipment.set("Inventory", armorItem("minecraft:iron_helmet", 4));
  assert.equal(scene.environment(scene.player).target, 70, "offhand and carried armor do not count");
  scene.equipment.set("Chest", armorItem("minecraft:iron_chestplate", 4));
  scene.player.armorQueries = 0;
  scene.tick();
  assert.equal(scene.player.armorQueries, 4, "one four-slot scan per second, not on every activity tick");
  assert.equal(scene.environment(scene.player).target, 66);
  scene.equipment.delete("Chest");
  assert.equal(scene.environment(scene.player).target, 70, "removing armor immediately affects the next sample");
  scene.equipment.set("Chest", { typeId: "minecraft:iron_chestplate", getComponent: () => undefined });
  assert.equal(scene.environment(scene.player).target, 70, "missing enchantable components are safe");
});

test(`${edition}: enchanted armor keeps powder-snow caps and disabled or creative mode protections`, () => {
  const scene = harness(undefined, implementation);
  scene.equipment.set("Chest", armorItem("minecraft:leather_chestplate", 4));
  scene.setHeat("minecraft:lava");
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.command("70");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5, "insulation cannot evade the body-contact snow cap");
  scene.setTemperatureEnabled(false);
  scene.player.armorQueries = 0;
  scene.tick();
  assert.equal(scene.player.armorQueries, 0, "disabled temperature does not sample worn enchantments");
  scene.setTemperatureEnabled(true);
  scene.player.mode = "creative";
  scene.tick();
  assert.equal(scene.player.armorQueries, 0);
  assert.deepEqual(scene.warnings, []);
});

test(`${edition}: only lit furnaces heat, and magma uses the same distance falloff`, () => {
  for (const [id, gains] of [
    ["minecraft:lit_furnace", [15, 11, 8, 4, 0]],
    ["minecraft:lit_blast_furnace", [15, 11, 8, 4, 0]],
    ["minecraft:lit_smoker", [15, 11, 8, 4, 0]],
    ["minecraft:magma", [10, 8, 5, 3, 0]]
  ]) for (let distance = 1; distance <= 5; distance++) {
    const scene = harness(undefined, implementation);
    scene.setHeat(id, 64, distance);
    const environment = scene.environment(scene.player);
    assert.equal(environment.target, 50 + gains[distance - 1], `${id}, distance ${distance}`);
    assert.equal(environment.dryingFast, distance <= 4);
  }
  const scene = harness(undefined, implementation);
  for (const [lit, idle] of [
    ["minecraft:lit_furnace", "minecraft:furnace"],
    ["minecraft:lit_blast_furnace", "minecraft:blast_furnace"],
    ["minecraft:lit_smoker", "minecraft:smoker"]
  ]) {
    scene.setHeat(lit);
    assert.equal(scene.environment(scene.player).target, 65);
    scene.setHeat(idle);
    assert.equal(scene.environment(scene.player).target, 50, `${idle} no longer emits heat`);
  }
  scene.setHeat(undefined);
  scene.setFooting("minecraft:magma");
  assert.equal(scene.environment(scene.player).target, 60, "magma beneath the feet also warms");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 51, "heat is gradual, not an instant temperature gain");
});

test(`${edition}: new sources still take the strongest heat and work in cold biomes`, () => {
  const scene = harness(undefined, implementation);
  scene.setHeat("minecraft:lit_furnace");
  scene.setBlock(-1, 64, 0, "minecraft:lit_blast_furnace");
  scene.setBlock(0, 64, -1, "minecraft:lit_smoker");
  scene.setFooting("minecraft:magma");
  assert.equal(scene.environment(scene.player).target, 65, "four heat sources do not sum");
  scene.setBlock(1, 65, 0, "minecraft:fire");
  assert.equal(scene.environment(scene.player).target, 70, "existing stronger fire wins");
  scene.setBlock(1, 65, 0, "minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 80, "lava still wins over the new sources");
  scene.setBlock(1, 65, 0, "minecraft:air");
  scene.setBlock(2, 64, 0, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 50, "strongest heat and cold still cancel");
  scene.setBiome("minecraft:ice_plains");
  scene.setTime(6000);
  scene.setRoof(true);
  assert.equal(scene.environment(scene.player).target, 40, "new heat remains active in cold biomes");
});

test(`${edition}: actual fire resistance eases a hot target and ends when the effect disappears`, () => {
  const scene = harness(undefined, implementation);
  scene.player.dimension.id = "minecraft:nether";
  assert.equal(scene.environment(scene.player).target, 85);
  scene.effects.set("minecraft:strength", { amplifier: 0 });
  assert.equal(scene.environment(scene.player).target, 85, "an unrelated potion cannot insulate");
  scene.effects.set("minecraft:fire_resistance", { amplifier: 0 });
  assert.equal(scene.environment(scene.player).target, 65);
  assert.equal(scene.environment(scene.player).warmingRate, 0.5);
  assert.equal(scene.environment(scene.player).coolingRate, 1, "cooling is not slowed");
  assert.equal(scene.stateFor(scene.player).value, 50, "receiving the effect does not reset current temperature");
  scene.tick(10);
  assert.equal(scene.stateFor(scene.player).value, 55);
  scene.effects.set("minecraft:fire_resistance", { amplifier: 5 });
  assert.equal(scene.environment(scene.player).target, 65, "effect strength does not multiply insulation");
  scene.effects.delete("minecraft:fire_resistance");
  assert.equal(scene.environment(scene.player).target, 85);
  assert.equal(scene.environment(scene.player).warmingRate, 1);
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 56, "no saved protection remains after expiration or removal");
});

test(`${edition}: insulation applies after the upper target cap and never pushes a warm target below fifty`, () => {
  const scene = harness(undefined, implementation);
  scene.player.dimension.id = "minecraft:nether";
  scene.setHeat("minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 100);
  scene.effects.set("minecraft:fire_resistance", { amplifier: 0 });
  assert.equal(scene.environment(scene.player).target, 80, "even excess raw heat gets the twenty-point relief");
  scene.player.dimension.id = "minecraft:overworld";
  scene.setHeat(undefined);
  scene.setTime(6000);
  assert.equal(scene.environment(scene.player).target, 50, "sunny target 55 cannot be overcooled");
  assert.equal(scene.environment(scene.player).warmingRate, 1, "the resulting normal-target rate is halved");
  scene.setRoof(true);
  const normal = scene.environment(scene.player);
  assert.equal(normal.target, 50);
  assert.equal(normal.warmingRate, 2, "ordinary neutral warmth is unaffected");
  scene.setRoof(false);
  scene.setTime(13000);
  scene.setOnFire(true);
  assert.equal(scene.environment(scene.player).target, 50);
  assert.equal(scene.environment(scene.player).warmingRate, 3, "the normal-target rate, burning and insulation compose");
  assert.equal(scene.environment(scene.player).dryingFast, true, "insulation does not cancel drying by fire");
});

test(`${edition}: fire resistance does not worsen cold, slow cold-water cooling or block powder snow`, () => {
  const scene = harness(undefined, implementation);
  scene.setBiome("minecraft:ice_plains");
  scene.setTime(6000);
  scene.setRoof(true);
  const cold = scene.environment(scene.player);
  scene.effects.set("minecraft:fire_resistance", { amplifier: 0 });
  assert.deepEqual(scene.environment(scene.player), cold);
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 5);
  assert.equal(scene.environment(scene.player).coolingRate, 3);
  scene.player.isInWater = false;
  scene.setHeat("minecraft:lava");
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.command("70");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5);
  const buried = scene.environment(scene.player);
  scene.effects.delete("minecraft:fire_resistance");
  assert.deepEqual(scene.environment(scene.player), buried, "powder-snow behavior is unchanged");
});

test(`${edition}: fire resistance is not a script temperature-damage exemption and respects the world switch`, () => {
  const scene = harness(undefined, implementation);
  scene.player.dimension.id = "minecraft:nether";
  scene.effects.set("minecraft:fire_resistance", { amplifier: 0 });
  scene.command("100");
  scene.tick(8);
  assert.equal(scene.stateFor(scene.player).value, 92);
  assert.equal(scene.damage.length, 1, "existing dangerous body heat still causes damage");
  assert.equal(scene.damage[0].cause, "temperature");
  scene.setTemperatureEnabled(false);
  scene.tick(20);
  assert.equal(scene.stateFor(scene.player).value, 92);
  assert.equal(scene.damage.length, 1, "disabled temperature causes neither change nor damage");
  scene.setTemperatureEnabled(true);
  scene.player.mode = "creative";
  scene.tick(20);
  assert.equal(scene.stateFor(scene.player).value, 92);
  assert.equal(scene.damage.length, 1, "creative mode remains exempt");
  assert.deepEqual(scene.warnings, []);
});
}

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
test(`${edition}: nearby ice and snow cool gradually with the shared four-block distance falloff`, () => {
  for (const [typeId, amounts] of [
    ["minecraft:snow", [5, 4, 3, 1]], ["minecraft:snow_layer", [5, 4, 3, 1]],
    ["minecraft:powder_snow", [5, 4, 3, 1]], ["minecraft:ice", [10, 8, 5, 3]],
    ["minecraft:packed_ice", [15, 11, 8, 4]], ["minecraft:blue_ice", [20, 15, 10, 5]]
  ]) {
    for (let distance = 1; distance <= 5; distance++) {
      const scene = harness(undefined, implementation);
      scene.setBlock(distance, 64, 0, typeId);
      assert.equal(scene.environment(scene.player).target, 50 - (amounts[distance - 1] ?? 0),
        `${typeId}, distance ${distance}`);
      assert.equal(scene.environment(scene.player).powderSnow, false, "nearby is not body contact");
    }
  }
  const scene = harness(undefined, implementation);
  scene.setBlock(3, 64, 3, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 50, "outside the circular radius");
  scene.setBlock(3, 64, 2, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 43, "diagonal distance, not a square radius");
  scene.setBlock(3, 64, 2, "minecraft:air");
  scene.player.location.y = 63.875;
  scene.setBlock(1, 65, 0, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 30, "head-height source above partial-block footing");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 49, "nearby cooling is not an instant reset");
  scene.tick(19);
  assert.equal(scene.stateFor(scene.player).value, 30);
  scene.setBlock(1, 65, 0, "minecraft:air");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 32, "leaving resumes ordinary gradual warming");
});

test(`${edition}: cold sources take the strongest value and offset heat without stacking`, () => {
  const scene = harness(undefined, implementation);
  scene.setBlock(-1, 64, 0, "minecraft:blue_ice");
  scene.setBlock(0, 64, -1, "minecraft:packed_ice");
  scene.setBlock(2, 64, 0, "minecraft:ice");
  assert.equal(scene.environment(scene.player).target, 30, "three sources do not sum");
  scene.setHeat("minecraft:fire");
  assert.equal(scene.environment(scene.player).target, 50, "heat and cold cancel at the target");
  scene.setBlock(0, 65, -1, "minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 60, "strongest heat minus strongest cold");
  scene.setHeat(undefined);
  scene.setBlock(0, 65, -1, "minecraft:air");
  scene.setOnFire(true);
  const burning = scene.environment(scene.player);
  assert.equal(burning.target, 50, "on-fire minimum heat also offsets nearby cold");
  assert.equal(burning.warmingRate, 6, "on-fire warming multiplier remains unchanged");
  assert.equal(burning.dryingFast, true, "cold does not redefine the existing drying rule");
  scene.setOnFire(false);
  for (const [dimension, expected] of [["minecraft:nether", 65], ["minecraft:the_end", 15]]) {
    scene.player.dimension.id = dimension;
    assert.equal(scene.environment(scene.player).target, expected, dimension);
  }
  scene.player.dimension.id = "minecraft:overworld";
  scene.setBlock(-1, 64, 0, "minecraft:air");
  scene.setBlock(0, 64, -1, "minecraft:air");
  scene.setBlock(4, 64, 0, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 42, "nearby ice can be stronger than distant blue ice");
});

test(`${edition}: all cold biomes disable only nearby ice and snow cooling, not heat, water or powder-snow contact`, () => {
  const scene = harness(undefined, implementation);
  scene.setRoof(true);
  scene.setBlock(1, 64, 0, "minecraft:blue_ice");
  scene.setBlock(-1, 64, 0, "minecraft:snow_layer");
  for (const biome of scene.COLD_BIOMES) {
    scene.setBiome(biome);
    scene.setTime(6000);
    assert.equal(scene.environment(scene.player).target, 25, `${biome}: day`);
    scene.setTime(18000);
    assert.equal(scene.environment(scene.player).target, 15, `${biome}: night`);
  }
  scene.setHeat("minecraft:fire", 64, 0, -1);
  assert.equal(scene.environment(scene.player).target, 35, "cold-biome heat still works");
  scene.setHeat(undefined);
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 0, "cold water still subtracts twenty");
  scene.player.isInWater = false;
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5, "body-contact cap remains active in cold biomes");
  scene.setBlock(0, 64, 0, "minecraft:air");
  scene.setTime(13000);
  for (const [biome, expected] of [["minecraft:plains", 30], ["minecraft:jungle", 40], ["minecraft:desert", 25]]) {
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, expected, `${biome}: cooling re-enabled after moving biomes`);
  }
});

test(`${edition}: heat and cold share one bounded scan and respect disabled or creative modes`, () => {
  const scene = harness(undefined, implementation);
  scene.setBlock(1, 64, 0, "minecraft:blue_ice");
  const queries = [];
  const getBlock = scene.player.dimension.getBlock;
  scene.player.dimension.getBlock = (location) => {
    queries.push(location);
    assert.ok(location.y >= -64 && location.y < 320, "never query outside world height");
    if (location.x === -1 && location.z === -1) throw new Error("LocationInUnloadedChunkError");
    return getBlock(location);
  };
  scene.setTemperatureEnabled(false);
  scene.tick();
  assert.equal(queries.length, 0);
  assert.equal(scene.stateFor(scene.player).value, 50);
  scene.setTemperatureEnabled(true);
  scene.player.mode = "creative";
  scene.tick();
  assert.equal(queries.length, 0);
  scene.player.mode = "survival";
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 49);
  assert.equal(queries.filter(({ x, y, z }) => x === 1 && y === 64 && z === 0).length, 1,
    "the source cell is scanned once, not once per heat/cold family");
  assert.ok(queries.length <= 170, "no second wide scan was added");
  queries.length = 0;
  scene.player.location.y = 319;
  scene.player.getHeadLocation = () => ({ x: 0, y: 320, z: 0 });
  scene.setBlock(1, 319, 0, "minecraft:blue_ice");
  assert.equal(scene.environment(scene.player).target, 10, "altitude plus accessible cold source near world ceiling");
  assert.deepEqual(scene.warnings, []);
});

test(`${edition}: entering powder snow immediately lowers current temperature to five`, () => {
  const scene = harness(undefined, implementation);
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5);
  assert.equal(scene.properties.get("ot:temperature_value"), 5);
  assert.equal(scene.properties.get("ot:temperature_tier"), 0);
  assert.equal(scene.scores.get(scene.player.id), 5);
});

test(`${edition}: powder-snow contact covers the body and block edges but not standing on top or ordinary snow`, () => {
  for (const [x, y, z] of [[0, 64, 0], [0, 65, 0], [-1, 64, 0], [-1, 65, -1]]) {
    const scene = harness(undefined, implementation);
    scene.setBlock(x, y, z, "minecraft:powder_snow");
    scene.tick();
    assert.equal(scene.stateFor(scene.player).value, 5, `body contact at ${x},${y},${z}`);
  }
  const edge = harness(undefined, implementation);
  edge.player.location.x = 0.7;
  edge.setBlock(1, 64, 0, "minecraft:powder_snow");
  edge.tick();
  assert.equal(edge.environment(edge.player).powderSnow, false, "touching the block face is not being inside it");
  assert.equal(edge.stateFor(edge.player).value, 49, "nearby powder snow only cools gradually without overlap");
  edge.player.location.x = 0.85;
  edge.tick();
  assert.equal(edge.stateFor(edge.player).value, 5, "partial body overlap counts even when its center is outside");
  const negative = harness(undefined, implementation);
  negative.player.location.x = negative.player.location.z = -1.1;
  negative.setBlock(-2, 64, -2, "minecraft:powder_snow");
  negative.tick();
  assert.equal(negative.stateFor(negative.player).value, 5, "negative block coordinates use floor, not truncation");
  const top = harness(undefined, implementation);
  top.player.location.y = 65;
  top.armor.add("Feet");
  top.setBlock(0, 64, 0, "minecraft:powder_snow");
  top.tick();
  assert.equal(top.environment(top.player).powderSnow, false, "standing on the surface does not count as falling in");
  assert.equal(top.environment(top.player).target, 47, "nearby snow subtracts five and dry boots add two");
  assert.equal(top.stateFor(top.player).value, 49.125, "boots still slow ordinary cooling without triggering the contact cap");
  for (const typeId of ["minecraft:snow", "minecraft:snow_layer"]) {
    const scene = harness(undefined, implementation);
    scene.setBlock(0, 64, 0, typeId);
    scene.tick();
    assert.equal(scene.environment(scene.player).powderSnow, false, typeId);
    assert.equal(scene.stateFor(scene.player).value, 49, `${typeId}: ordinary nearby cooling, not an instant cap`);
  }
});

test(`${edition}: powder-snow cold caps warmth, preserves colder values, resumes after leaving and respects the switch`, () => {
  const scene = harness(undefined, implementation);
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.setHeat("minecraft:lava");
  scene.setOnFire(true);
  for (const slot of ["Head", "Chest", "Legs", "Feet"]) scene.armor.add(slot);
  scene.tick(8);
  assert.equal(scene.stateFor(scene.player).value, 5, "nearby heat and armor cannot keep a buried player warm");
  assert.equal(scene.damage.length, 1, "existing cold damage applies without a new damage timer");
  scene.command("2");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 2, "powder snow must not warm colder players to five");
  scene.command("0");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 0, "the cap must not raise a zero-temperature player either");
  scene.setOnFire(false);
  scene.setHeat(undefined);
  scene.armor.clear();
  scene.setBlock(0, 64, 0, "minecraft:air");
  scene.command("5");
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 7, "leaving resumes normal gradual warming");
  scene.setBlock(0, 64, 0, "minecraft:powder_snow");
  scene.setTemperatureEnabled(false);
  scene.command("50");
  scene.tick(10);
  assert.equal(scene.stateFor(scene.player).value, 50, "world switch disables powder-snow cooling too");
  assert.equal(scene.damage.length, 1);
  scene.setTemperatureEnabled(true);
  scene.player.mode = "creative";
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 50, "creative players are not cooled");
  scene.player.mode = "survival";
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5, "re-enabling or changing mode restores detection");
});

test(`${edition}: powder-snow sampling clips world height and tolerates unavailable cells`, () => {
  const scene = harness(undefined, implementation);
  scene.player.location.y = 319;
  scene.player.getHeadLocation = () => ({ x: 0, y: 320, z: 0 });
  scene.setBlock(0, 319, 0, "minecraft:powder_snow");
  const outside = [];
  const getBlock = scene.player.dimension.getBlock;
  scene.player.dimension.getBlock = (location) => {
    if (location.y < -64 || location.y >= 320) {
      outside.push(location);
      throw new Error("LocationOutOfWorldBoundariesError");
    }
    if (location.x === -1 && location.z === -1) throw new Error("LocationInUnloadedChunkError");
    return getBlock(location);
  };
  scene.tick();
  assert.equal(scene.stateFor(scene.player).value, 5, "one inaccessible cell does not hide other powder snow");
  assert.deepEqual(outside, [], "no out-of-bounds query may be hidden by a catch");
  assert.deepEqual(scene.warnings, []);
});
}

test("five temperature tiers use the agreed boundaries and two-point hysteresis", () => {
  const { rawTier, tierFor } = harness();
  for (const [value, expected] of [[0, 0], [14, 0], [15, 1], [34, 1],
    [35, 2], [50, 2], [65, 2], [66, 3], [84, 3], [85, 4], [100, 4]]) {
    assert.equal(rawTier(value), expected);
  }
  assert.equal(tierFor(34, 2), 2);
  assert.equal(tierFor(33, 2), 1);
  assert.equal(tierFor(35, 1), 1);
  assert.equal(tierFor(37, 1), 2);
  assert.equal(tierFor(85, 3), 3);
  assert.equal(tierFor(87, 3), 4);
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
  test(`${edition}: subtropical jungle and warm-ocean families use sixty with existing environmental modifiers`, () => {
    const scene = harness(undefined, implementation);
    for (const biome of ["minecraft:jungle", "minecraft:jungle_hills", "minecraft:jungle_mutated",
      "minecraft:jungle_edge", "minecraft:jungle_edge_mutated", "minecraft:bamboo_jungle",
      "minecraft:bamboo_jungle_hills", "minecraft:warm_ocean", "minecraft:deep_warm_ocean"]) {
      scene.setBiome(biome);
      scene.setRoof(true);
      scene.setTime(6000);
      assert.equal(scene.environment(scene.player).target, 60, `${biome}: sheltered baseline`);
      scene.setTime(18000);
      assert.equal(scene.environment(scene.player).target, 60, `${biome}: indoor night stays at baseline`);
      scene.setRoof(false);
      assert.equal(scene.environment(scene.player).target, 54, `${biome}: exposed night still subtracts six`);
      scene.setTime(6000);
      assert.equal(scene.environment(scene.player).target, 65, `${biome}: sunlight still adds five`);
    }
    scene.weather("Rain");
    assert.equal(scene.environment(scene.player).target, 52, "subtropical is not the rain-exempt hot classification");
    scene.setTime(18000);
    assert.equal(scene.environment(scene.player).target, 46);
    assert.equal(scene.environment(scene.player).coolingRate, 1.5, "rain cooling still accelerates below fifty");
    scene.setRoof(true);
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 50, "ordinary water subtracts ten, not the cold-biome twenty");
    assert.equal(scene.environment(scene.player).coolingRate, 6);
    scene.player.isInWater = false;
    scene.setBlock(-1, 64, 0, "minecraft:blue_ice");
    assert.equal(scene.environment(scene.player).target, 40, "subtropical biomes retain nearby ice cooling");
    scene.setHeat("minecraft:fire");
    assert.equal(scene.environment(scene.player).target, 60, "existing heat and cold offsets still cancel");

    const ordinary = harness(undefined, implementation);
    ordinary.setRoof(true);
    ordinary.setTime(6000);
    for (const biome of ["minecraft:plains", "minecraft:forest", "minecraft:ocean",
      "minecraft:lukewarm_ocean", "minecraft:deep_lukewarm_ocean", "example:unknown_biome"]) {
      ordinary.setBiome(biome);
      assert.equal(ordinary.environment(ordinary.player).target, 50, `${biome}: unrelated classification unchanged`);
    }

    const gradual = harness(50, implementation);
    gradual.setBiome("minecraft:jungle");
    gradual.setRoof(true);
    gradual.setTime(6000);
    gradual.tick();
    assert.equal(gradual.stateFor(gradual.player).value, 51, "a new baseline is not an instant body-temperature reset");
    gradual.tick(9);
    assert.equal(gradual.stateFor(gradual.player).value, 60);
    assert.equal(gradual.damage.length, 0);
    gradual.setTemperatureEnabled(false);
    gradual.command("50");
    gradual.tick();
    assert.equal(gradual.stateFor(gradual.player).value, 50, "world switch still freezes temperature");
  });

  test(`${edition}: dry and cold biome day-night targets replace the generic night penalty`, () => {
    const scene = harness(undefined, implementation);
    const dryBiomes = [...scene.HOT_BIOMES].filter((biome) => !biome.includes("savanna"));
    for (const [biomes, day, night] of [[dryBiomes, 75, 30], [[...scene.COLD_BIOMES], 25, 15]]) {
      for (const biome of biomes) {
        scene.setBiome(biome);
        scene.setRoof(true);
        scene.setTime(6000);
        assert.equal(scene.environment(scene.player).target, day, `${biome}: sheltered day baseline`);
        scene.setRoof(false);
        assert.equal(scene.environment(scene.player).target, day + 5, `${biome}: sunlight still adds five`);
        scene.setTime(18000);
        assert.equal(scene.environment(scene.player).target, night, `${biome}: no extra minus six`);
        scene.setRoof(true);
        assert.equal(scene.environment(scene.player).target, night, `${biome}: ambient night also applies indoors`);
      }
    }
    for (const biome of [...scene.HOT_BIOMES].filter((biome) => biome.includes("savanna"))) {
      scene.setBiome(biome);
      scene.setRoof(false);
      assert.equal(scene.environment(scene.player).target, 69, `${biome}: keep the existing exposed-night rule`);
      scene.setRoof(true);
      assert.equal(scene.environment(scene.player).target, 75, `${biome}: sheltered savanna stays unchanged`);
    }
  });

  test(`${edition}: dusk and dawn interpolate continuously across midnight without jumping body temperature`, () => {
    const scene = harness(undefined, implementation);
    scene.setRoof(true);
    for (const [biome, day, night] of [["minecraft:desert", 75, 30], ["minecraft:snowy_plains", 25, 15]]) {
      scene.setBiome(biome);
      for (const [time, daylight] of [[1000, 1], [6000, 1], [11000, 1], [12500, 0.5],
        [14000, 0], [18000, 0], [22000, 0], [23500, 0.5], [0, 2 / 3], [500, 5 / 6]]) {
        scene.setTime(time);
        assert.ok(Math.abs(scene.environment(scene.player).target - (night + (day - night) * daylight)) < 1e-9,
          `${biome}: target at time ${time}`);
      }
      for (const [before, after] of [[999, 1000], [11000, 11001], [13999, 14000],
        [22000, 22001], [23999, 0]]) {
        scene.setTime(before);
        const previous = scene.environment(scene.player).target;
        scene.setTime(after);
        assert.ok(Math.abs(scene.environment(scene.player).target - previous) < 0.02,
          `${biome}: continuous boundary ${before} -> ${after}`);
      }
    }
    scene.setBiome("minecraft:desert");
    scene.setTime(6000);
    scene.tick();
    assert.equal(scene.stateFor(scene.player).value, 51, "day target does not instantly change body temperature");
    scene.setTime(18000);
    scene.tick();
    assert.equal(scene.stateFor(scene.player).value, 50, "night target still uses the existing cooling rate");
  });

  test(`${edition}: cold nights retain protection, environmental modifiers and the strict below-fifteen damage boundary`, () => {
    const scene = harness(undefined, implementation);
    scene.setBiome("minecraft:snowy_plains");
    scene.setTime(18000);
    assert.equal(scene.environment(scene.player).target, 15);
    scene.command("15");
    scene.tick(20);
    assert.equal(scene.stateFor(scene.player).value, 15);
    assert.equal(scene.damage.length, 0, "exactly fifteen alone must not cause cold damage");
    scene.armor.add("Chest");
    assert.equal(scene.environment(scene.player).target, 17);
    scene.armor.clear();
    scene.setHeat("minecraft:fire");
    assert.equal(scene.environment(scene.player).target, 35);
    scene.setHeat(undefined);
    scene.weather("Rain");
    assert.equal(scene.environment(scene.player).target, 7);
    scene.weather("Clear");
    scene.setHunger(6);
    assert.equal(scene.environment(scene.player).target, 10);
    scene.tick(8);
    assert.equal(scene.damage.length, 1, "hunger can push a cold night into damaging cold");
    scene.setHunger(20);
    scene.player.location.y = 128;
    assert.equal(scene.environment(scene.player).target, 11);
    scene.player.location.y = 64;
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 0);
    scene.player.isInWater = false;
    scene.setBiome("minecraft:desert");
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 20, "dry-biome water keeps its ten-point deduction");
  });
}

test("cold biome and rain cool gradually; dry leather insulates but wet leather does not", () => {
  const scene = harness();
  scene.tick();
  assert.equal(scene.scores.get(scene.player.id), 50);
  assert.equal(scene.properties.get("ot:temperature_tier"), 2);
  scene.setBiome("minecraft:snowy_plains");
  scene.tick(17);
  assert.equal(scene.properties.get("ot:temperature_value"), 33);
  assert.equal(scene.properties.get("ot:temperature_tier"), 1);
  assert.equal(scene.properties.get("ot:stamina_recovery_multiplier"), 0.8);
  scene.weather("Rain");
  scene.tick(14);
  assert.equal(scene.properties.get("ot:temperature_tier"), 0);
  assert.equal(scene.properties.get("ot:stamina_recovery_multiplier"), 0.5);

  scene.command("50");
  for (const slot of ["Head", "Chest", "Legs", "Feet"]) scene.armor.add(slot);
  scene.tick(20);
  assert.equal(scene.properties.get("ot:temperature_value"), 20);
  assert.equal(scene.properties.get("ot:temperature_tier"), 1);

  const dry = harness();
  dry.setBiome("minecraft:snowy_plains");
  for (const slot of ["Head", "Chest", "Legs", "Feet"]) dry.armor.add(slot);
  dry.tick(20);
  assert.equal(dry.properties.get("ot:temperature_value"), 40);
  assert.equal(dry.properties.get("ot:temperature_tier"), 2);
});

test("sun, heat sources, water and movement shape the target without instant jumps", () => {
  const scene = harness();
  scene.setTime(6000);
  scene.setBiome("minecraft:desert");
  scene.player.isSprinting = true;
  assert.equal(scene.environment(scene.player).target, 85);
  scene.tick(37);
  assert.equal(scene.properties.get("ot:temperature_value"), 85);
  assert.equal(scene.properties.get("ot:temperature_tier"), 3);
  assert.equal(scene.properties.get("ot:thirst_loss_multiplier"), 1.25);
  scene.setTemperatureEnabled(false);
  scene.tick(5);
  assert.equal(scene.properties.get("ot:temperature_value"), 85);
  assert.equal(scene.properties.get("ot:thirst_loss_multiplier"), undefined);
  scene.weather("Rain");
  assert.equal(scene.worldProperties.get("ot:temperature_weather"), "Rain",
    "温度关闭时仍要记录天气，供独立的口渴系统使用");
  scene.weather("Clear");

  scene.setTemperatureEnabled(true);
  scene.setBiome("minecraft:plains");
  scene.player.isSprinting = false;
  scene.setTime(13000);
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 40);
  scene.player.isInWater = false;
  scene.setHeat("minecraft:campfire");
  assert.equal(scene.environment(scene.player).target, 70);
  scene.setRoof(true);
  scene.setTime(6000);
  assert.equal(scene.environment(scene.player).target, 70, "屋顶挡住日晒，不挡近处热源");
  scene.weather("Rain");
  assert.equal(scene.environment(scene.player).target, 70, "屋顶也挡住降水");
});

test("hot biome direct sunlight alone stays below the heat-damage threshold", () => {
  const scene = harness();
  scene.setTime(6000);
  scene.setBiome("minecraft:desert");
  assert.equal(scene.environment(scene.player).target, 80);
  scene.tick(60);
  assert.equal(scene.properties.get("ot:temperature_value"), 80);
  assert.equal(scene.damage.length, 0);
});

test("head-height fire still warms a player standing low on soul sand", () => {
  const normal = harness();
  normal.setHeat("minecraft:fire", 65);
  assert.equal(normal.environment(normal.player).target, 70);

  const soulSand = harness();
  soulSand.player.location.y = 63.875;
  soulSand.setHeat("minecraft:fire", 64);
  assert.equal(soulSand.environment(soulSand.player).target, 70, "脚边的火仍在扫描范围内");
  soulSand.setHeat("minecraft:fire", 65);
  assert.equal(soulSand.environment(soulSand.player).target, 70, "低于整数方块顶面的脚部高度");
  soulSand.setFooting("minecraft:soul_sand");
  assert.equal(soulSand.environment(soulSand.player).target, 70, "完整的灵魂沙场景");
  soulSand.tick();
  assert.equal(soulSand.properties.get("ot:temperature_value"), 51);
  soulSand.setHeat("minecraft:soul_campfire", 65);
  assert.equal(soulSand.environment(soulSand.player).target, 70);
  soulSand.setHeat("minecraft:lava", 65);
  assert.equal(soulSand.environment(soulSand.player).target, 80);
  soulSand.setHeat("minecraft:fire", 66);
  assert.equal(soulSand.environment(soulSand.player).target, 50, "头部上方一整格不应受热");
});

test("fire and lava warm from a few blocks away, weakening with distance", () => {
  const scene = harness();
  scene.setHeat("minecraft:fire", 64, 2);
  assert.equal(scene.environment(scene.player).target, 65);
  scene.tick();
  assert.equal(scene.scores.get(scene.player.id), 51, "隔着一格也会逐渐升温");
  scene.setHeat("minecraft:fire", 64, 3);
  assert.equal(scene.environment(scene.player).target, 60);
  scene.setHeat("minecraft:fire", 64, 4);
  assert.equal(scene.environment(scene.player).target, 55);
  scene.setHeat("minecraft:fire", 64, 3, 3);
  assert.equal(scene.environment(scene.player).target, 50, "斜向超出四格半径不加热");
  scene.setHeat("minecraft:fire", 64, 5);
  assert.equal(scene.environment(scene.player).target, 50);
  scene.setHeat("minecraft:lava", 64, 2);
  assert.equal(scene.environment(scene.player).target, 73);
});

test("cold water lowers the cold-biome target instead of merely capping it", () => {
  const scene = harness();
  scene.setBiome("minecraft:snowy_plains");
  scene.setTime(6000);
  scene.setRoof(true);
  const dry = scene.environment(scene.player).target;
  scene.player.isInWater = true;
  assert.equal(dry, 25);
  assert.equal(scene.environment(scene.player).target, 5);
  for (const slot of ["Head", "Chest", "Legs", "Feet"]) scene.armor.add(slot);
  assert.equal(scene.environment(scene.player).target, 5, "浸水时皮革不再保温");
  assert.equal(scene.environment(scene.player).coolingRate, 3);
});

test("water subtracts ten from hot ambient temperature rather than clamping every biome", () => {
  const scene = harness();
  scene.setBiome("minecraft:desert");
  scene.setTime(6000);
  scene.setRoof(true);
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 65);
});

test("Bedrock mesa badlands uses the hot daytime baseline instead of ordinary plains", () => {
  const scene = harness();
  scene.setTime(6000);
  scene.setRoof(true);
  for (const biome of ["minecraft:mesa", "minecraft:mesa_bryce", "minecraft:mesa_mutated",
    "minecraft:mesa_plateau", "minecraft:mesa_plateau_mutated",
    "minecraft:mesa_plateau_stone", "minecraft:mesa_plateau_stone_mutated",
    "minecraft:desert_hills", "minecraft:desert_mutated",
    "minecraft:savanna_mutated", "minecraft:savanna_plateau_mutated"]) {
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, 75, biome);
  }
  scene.setBiome("minecraft:jungle");
  assert.equal(scene.environment(scene.player).target, 60, "丛林归入亚热带，不套用炎热群系的 75");
});

test("other Bedrock snowy and cold variants use the cold daytime baseline", () => {
  const scene = harness();
  scene.setTime(6000);
  scene.setRoof(true);
  for (const biome of ["minecraft:ice_mountains", "minecraft:grove",
    "minecraft:cold_taiga_hills", "minecraft:cold_taiga_mutated",
    "minecraft:cold_beach", "minecraft:cold_ocean", "minecraft:deep_cold_ocean",
    "minecraft:legacy_frozen_ocean"]) {
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, 25, biome);
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 5, `${biome} 冷水`);
    scene.player.isInWater = false;
  }
});

test("Bedrock ice plains and cold taiga use the cold-water baseline", () => {
  for (const biome of ["minecraft:ice_plains", "minecraft:ice_plains_spikes", "minecraft:cold_taiga"]) {
    const scene = harness();
    scene.setBiome(biome);
    scene.setTime(6000);
    scene.setRoof(true);
    assert.equal(scene.environment(scene.player).target, 25, biome);
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 5, biome);
  }
});

test("an exposed night cools below the ordinary ambient target", () => {
  const scene = harness();
  scene.setTime(18000);
  assert.equal(scene.environment(scene.player).target, 44);
  scene.setRoof(true);
  assert.equal(scene.environment(scene.player).target, 50, "屋内不受露天夜间降温");
});

test("the End aims for 35 regardless of altitude without changing other dimension baselines", () => {
  const scene = harness();
  assert.equal(scene.environment(scene.player).target, 50);
  scene.player.dimension.id = "minecraft:the_end";
  scene.player.location.y = 320;
  assert.equal(scene.environment(scene.player).target, 35);
  scene.tick(5);
  assert.equal(scene.properties.get("ot:temperature_value"), 45, "当前温度逐秒趋近，不瞬间跳到 35");
  scene.player.dimension.id = "minecraft:nether";
  assert.equal(scene.environment(scene.player).target, 85);
});

test("wetness lingers after leaving water or rain and dries faster in sun or by fire", () => {
  const scene = harness();
  const state = scene.stateFor(scene.player);
  scene.player.isInWater = true;
  scene.tick();
  assert.equal(state.wetSeconds, 90);
  scene.player.isInWater = false;
  assert.equal(scene.environment(scene.player, 0, state.wetSeconds).target, 45);
  scene.tick();
  assert.equal(state.wetSeconds, 89);
  scene.setTime(6000);
  scene.tick();
  assert.equal(state.wetSeconds, 86);
  scene.setTime(13000);
  scene.setHeat("minecraft:fire");
  scene.tick();
  assert.equal(state.wetSeconds, 83);
  scene.setHeat(undefined);
  scene.tick(83);
  assert.equal(state.wetSeconds, 0);
  assert.equal(scene.properties.get("ot:temperature_wet_seconds"), undefined);

  scene.weather("Rain");
  scene.tick();
  assert.equal(state.wetSeconds, 90);
  scene.setRoof(true);
  scene.tick();
  assert.equal(state.wetSeconds, 89, "屋檐下不继续淋湿");
});

test("completed stew warms only active survival players and wetness survives rejoining", () => {
  const scene = harness();
  scene.player.isInWater = true;
  scene.tick();
  scene.player.isInWater = false;
  scene.leave();
  scene.tick();
  assert.equal(scene.stateFor(scene.player).wetSeconds, 89);
  scene.command("50");
  scene.consume("minecraft:mushroom_stew");
  assert.equal(scene.properties.get("ot:temperature_value"), 58);
  scene.consume("minecraft:apple");
  assert.equal(scene.properties.get("ot:temperature_value"), 58);
  scene.player.mode = "creative";
  scene.consume("minecraft:rabbit_stew");
  assert.equal(scene.properties.get("ot:temperature_value"), 58);
  scene.player.mode = "survival";
  scene.setTemperatureEnabled(false);
  scene.consume("minecraft:beetroot_soup");
  assert.equal(scene.properties.get("ot:temperature_value"), 58);
  assert.equal(scene.properties.get("ot:temperature_wet_seconds"), undefined);
  scene.setTemperatureEnabled(true);
  scene.command("98");
  scene.consume("minecraft:suspicious_stew");
  assert.equal(scene.properties.get("ot:temperature_value"), 100, "温度不超过 100");
});

test("high overworld altitude and actual Elytra gliding cool without changing Nether altitude", () => {
  const scene = harness();
  scene.player.location.y = 96;
  assert.equal(scene.environment(scene.player).target, 50);
  scene.player.location.y = 112;
  assert.equal(scene.environment(scene.player).target, 48);
  scene.player.location.y = 128;
  assert.equal(scene.environment(scene.player).target, 46);
  scene.worldProperties.set("ot:elytra_lift_enabled", false);
  scene.player.isGliding = true;
  assert.equal(scene.environment(scene.player).target, 40);
  assert.equal(scene.environment(scene.player).coolingRate, 1.5);
  scene.player.isGliding = false;
  scene.player.location.y = 256;
  assert.equal(scene.environment(scene.player).target, 30, "高空降温最多 20 点");
  scene.player.dimension.id = "minecraft:nether";
  assert.equal(scene.environment(scene.player).target, 85, "海拔修正只在主世界生效");
});

test("temperature sampling above world height does not warn or stop updating", () => {
  const scene = harness();
  const locationError = (location) => new Error(`LocationOutOfWorldBoundariesError: Trying to access location (${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)}) which is outside of the world boundaries.`);
  scene.player.location = { x: -43, y: 332, z: -3 };
  scene.player.getHeadLocation = () => ({ x: -43, y: 333, z: -3 });
  scene.player.dimension.heightRange = { min: -64, max: 320 };
  scene.player.dimension.getBiome = (location) => {
    if (location.y >= 320) throw locationError(location);
    return { id: "minecraft:plains" };
  };
  scene.player.dimension.getSkyLightLevel = (location) => {
    if (location.y >= 320) throw locationError(location);
    return 15;
  };
  scene.setTime(13000);
  scene.tick();
  assert.deepEqual(scene.warnings, []);
  assert.equal(scene.scores.get(scene.player.id), 49);
});

test("temperature daylight sampling tolerates a head above the build ceiling", () => {
  const scene = harness();
  scene.player.location = { x: -43, y: 319, z: -3 };
  scene.player.getHeadLocation = () => ({ x: -43, y: 320, z: -3 });
  scene.player.dimension.heightRange = { min: -64, max: 320 };
  scene.player.dimension.getSkyLightLevel = (location) => {
    if (location.y >= 320) throw new Error(`LocationOutOfWorldBoundariesError: sky light at Y=${location.y}`);
    return 15;
  };
  scene.setTime(6000);
  scene.tick();
  assert.deepEqual(scene.warnings, []);
  assert.equal(scene.scores.get(scene.player.id), 49);
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]])
test(`${edition}: burning floors heat at twenty, keeps stronger nearby heat, and warms three times faster`, () => {
  const scene = harness(undefined, implementation);
  scene.setOnFire(true);
  assert.equal(scene.environment(scene.player).target, 70);
  assert.equal(scene.environment(scene.player).warmingRate, 3);
  scene.setHeat("minecraft:fire", 64, 3);
  assert.equal(scene.environment(scene.player).target, 70, "weak nearby fire cannot reduce the twenty-point floor");
  scene.setHeat("minecraft:fire");
  assert.equal(scene.environment(scene.player).target, 70, "body fire and nearby fire never stack");
  scene.setHeat("minecraft:lava");
  assert.equal(scene.environment(scene.player).target, 80, "stronger nearby lava wins over body fire");
  scene.command("50");
  scene.tick(3);
  assert.equal(scene.stateFor(scene.player).value, 59);
  scene.setOnFire(false);
  assert.equal(scene.environment(scene.player).target, 80);
  assert.equal(scene.environment(scene.player).warmingRate, 1);
});

test("burning, leather and low food change the body's temperature independently", () => {
  const scene = harness();
  scene.setOnFire(true);
  assert.equal(scene.environment(scene.player).target, 70, "着火本身加热，即使附近没有火方块");
  assert.equal(scene.environment(scene.player).warmingRate, 3);
  scene.setOnFire(false);
  scene.setBiome("minecraft:snowy_plains");
  const cold = scene.environment(scene.player).target;
  scene.armor.add("Chest");
  assert.equal(scene.environment(scene.player).target, cold + 2, "皮革提高寒冷环境目标值");
  scene.setHunger(6);
  assert.equal(scene.environment(scene.player).target, cold - 3);
  scene.setHunger(0);
  assert.equal(scene.environment(scene.player).target, cold - 8, "饥饿削弱抗寒");
});

test("walking, jumping and swimming warm more than staying still", () => {
  const scene = harness();
  const still = scene.environment(scene.player).target;
  scene.setVelocity({ x: 0.1, y: 0, z: 0 });
  const walking = scene.environment(scene.player).target;
  assert.ok(walking > still);
  scene.player.isGliding = true;
  assert.equal(scene.environment(scene.player).target, still - 6, "滑翔不算行走产热，只应用风冷");
  scene.player.isGliding = false;
  scene.player.isOnGround = false;
  assert.equal(scene.environment(scene.player).target, still, "腾空的水平惯性不算行走");
  scene.player.isOnGround = true;
  scene.player.isJumping = true;
  assert.ok(scene.environment(scene.player).target > walking);
  scene.player.isJumping = false;
  scene.player.isInWater = true;
  const wading = scene.environment(scene.player).target;
  scene.player.isSwimming = true;
  assert.ok(scene.environment(scene.player).target > wading);
});

test("brief jumps, attacks and ongoing mining heat even with stamina and thirst disabled", () => {
  const scene = harness();
  scene.worldProperties.set("ot:stamina_enabled", false);
  scene.worldProperties.set("ot:thirst_enabled", false);
  const state = scene.stateFor(scene.player);
  scene.player.isJumping = true;
  scene.sample();
  scene.player.isJumping = false;
  scene.sample(19);
  assert.ok(state.activity >= 2, "短暂跳跃要保留到本秒温度结算");
  scene.swing();
  assert.ok(state.activity >= 4, "攻击独立产热");
  scene.mine();
  scene.sample(20);
  assert.ok(state.activity >= 5.9, "持续挖掘独立产热");
  assert.ok(Math.abs(scene.environment(scene.player, state.activity).target - 56) < 1e-6);
  scene.stopMine();
  scene.tick();
  assert.equal(state.activity, 0, "结算后清零，不把动作带到下一秒");
});

test("extreme heat and cold cause lethal-capable damage, faster in cold water, and respect the switch", () => {
  const cold = harness();
  cold.setBiome("minecraft:snowy_plains");
  cold.command("0");
  cold.tick(8);
  assert.equal(cold.damage.length, 1);
  assert.equal(cold.damage[0].amount, 1);
  assert.equal(cold.damage[0].cause, "temperature");
  cold.setTemperatureEnabled(false);
  cold.tick(20);
  assert.equal(cold.damage.length, 1);
  cold.setTemperatureEnabled(true);
  cold.command("0");
  cold.tick(7);
  assert.equal(cold.damage.length, 1, "重新开启后伤害计时从零开始");
  cold.tick();
  assert.equal(cold.damage.length, 2);

  const wet = harness();
  wet.setBiome("minecraft:snowy_plains");
  wet.player.isInWater = true;
  wet.command("0");
  wet.tick(2);
  assert.equal(wet.damage.length, 1);

  const hot = harness();
  hot.setBiome("minecraft:desert");
  hot.command("100");
  hot.tick(8);
  assert.equal(hot.damage.length, 1);
  hot.player.mode = "creative";
  hot.tick(20);
  assert.equal(hot.damage.length, 1);
});

test("scoreboard restores after removal, debug sets value, and death resets to 50", () => {
  const scene = harness();
  scene.tick();
  scene.player.mode = "creative";
  scene.command("15");
  scene.tick();
  assert.equal(scene.scores.get(scene.player.id), 15);
  assert.equal(scene.properties.get("ot:temperature_debug"), true);
  assert.equal(scene.properties.get("ot:stamina_recovery_multiplier"), undefined);
  const writes = scene.commands.length;
  scene.tick(10);
  assert.equal(scene.commands.length, writes);
  scene.removeObjective();
  scene.tick();
  assert.equal(scene.commands.length, writes + 1);
  scene.respawn();
  scene.tick();
  assert.equal(scene.scores.get(scene.player.id), 50);
  scene.command("off");
  assert.equal(scene.properties.get("ot:temperature_debug"), undefined);
  scene.command("101");
  assert.equal(scene.properties.get("ot:temperature_value"), 50);
  scene.player.playerPermissionLevel = 1;
  scene.command("0");
  assert.equal(scene.properties.get("ot:temperature_value"), 50);
});
