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
  const player = {
    id: "player-1", typeId: "minecraft:player", playerPermissionLevel: 2,
    mode: "survival", location: { x: 0, y: 64, z: 0 }, isInWater: false, isSprinting: false,
    isSwimming: false, isJumping: false,
    getGameMode() { return this.mode; },
    getHeadLocation() { return { x: 0, y: 65, z: 0 }; },
    getVelocity: () => velocity,
    getDynamicProperty: (key) => properties.get(key),
    setDynamicProperty: (key, value) => properties.set(key, value),
    getComponent: (id) => id === "minecraft:equippable"
      ? { getEquipment: (slot) => armor.has(slot) ? { typeId: "minecraft:leather_boots" } : undefined }
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
      getBlock: ({ x, y, z }) => ({ typeId: x === 0 && y === 64 && z === 1 ? "minecraft:stone"
        : heatBlock && x === heatX && y === heatY && z === heatZ
        ? heatBlock : footingBlock && x === 0 && y === 63 && z === 0
          ? footingBlock : "minecraft:air" })
    }
  };
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
  runInNewContext(`${flagsScript}\n${implementation}\nglobalThis.testApi = { rawTier, tierFor, environment, stateFor, temperatureEnabled, setTemperatureEnabled };`, sandbox);
  return {
    player, properties, worldProperties, scores, commands, messages, damage, warnings, armor,
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
    removeObjective: () => { objective = undefined; }
  };
}

test("old world temperature score seeds the independent pack", () => {
  const scene = harness(72);
  assert.equal(scene.stateFor(scene.player).value, 72);
  assert.equal(scene.properties.get("ot:temperature_value"), 72);
});

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
  const dry = scene.environment(scene.player).target;
  scene.player.isInWater = true;
  assert.equal(dry, 20);
  assert.equal(scene.environment(scene.player).target, 0);
  for (const slot of ["Head", "Chest", "Legs", "Feet"]) scene.armor.add(slot);
  assert.equal(scene.environment(scene.player).target, 0, "浸水时皮革不再保温");
  assert.equal(scene.environment(scene.player).coolingRate, 3);
});

test("water subtracts ten from hot ambient temperature rather than clamping every biome", () => {
  const scene = harness();
  scene.setBiome("minecraft:desert");
  scene.player.isInWater = true;
  assert.equal(scene.environment(scene.player).target, 65);
});

test("Bedrock mesa badlands uses the hot baseline instead of ordinary plains", () => {
  const scene = harness();
  for (const biome of ["minecraft:mesa", "minecraft:mesa_bryce", "minecraft:mesa_mutated",
    "minecraft:mesa_plateau", "minecraft:mesa_plateau_mutated",
    "minecraft:mesa_plateau_stone", "minecraft:mesa_plateau_stone_mutated",
    "minecraft:desert_hills", "minecraft:desert_mutated",
    "minecraft:savanna_mutated", "minecraft:savanna_plateau_mutated"]) {
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, 75, biome);
  }
  scene.setBiome("minecraft:jungle");
  assert.equal(scene.environment(scene.player).target, 50, "原先未列入的丛林暂不改价");
});

test("other Bedrock snowy and cold variants use the cold baseline", () => {
  const scene = harness();
  for (const biome of ["minecraft:ice_mountains", "minecraft:grove",
    "minecraft:cold_taiga_hills", "minecraft:cold_taiga_mutated",
    "minecraft:cold_beach", "minecraft:cold_ocean", "minecraft:deep_cold_ocean",
    "minecraft:legacy_frozen_ocean"]) {
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, 20, biome);
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 0, `${biome} 冷水`);
    scene.player.isInWater = false;
  }
});

test("Bedrock ice plains and cold taiga use the cold-water baseline", () => {
  for (const biome of ["minecraft:ice_plains", "minecraft:ice_plains_spikes", "minecraft:cold_taiga"]) {
    const scene = harness();
    scene.setBiome(biome);
    assert.equal(scene.environment(scene.player).target, 20, biome);
    scene.player.isInWater = true;
    assert.equal(scene.environment(scene.player).target, 0, biome);
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
