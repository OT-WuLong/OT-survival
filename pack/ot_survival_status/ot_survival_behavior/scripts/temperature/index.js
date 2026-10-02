import { EntityDamageCause, EquipmentSlot, GameMode, PlayerPermissionLevel, system, world } from "@minecraft/server";
import { legacyScore, statusEnabled, setStatusEnabled } from "../status_flags.js";

const VALUE_KEY = "ot:temperature_value";
const TIER_KEY = "ot:temperature_tier";
const DEBUG_KEY = "ot:temperature_debug";
const WEATHER_KEY = "ot:temperature_weather";
const WET_KEY = "ot:temperature_wet_seconds";
const THIRST_MULTIPLIER_KEY = "ot:thirst_loss_multiplier";
const STAMINA_MULTIPLIER_KEY = "ot:stamina_recovery_multiplier";
const SCORE_ID = "ot_temperature";
const COLD_BIOMES = new Set([
  "minecraft:snowy_plains", "minecraft:ice_spikes", "minecraft:snowy_taiga",
  "minecraft:ice_plains", "minecraft:ice_plains_spikes", "minecraft:cold_taiga",
  "minecraft:ice_mountains", "minecraft:grove", "minecraft:cold_taiga_hills",
  "minecraft:cold_taiga_mutated", "minecraft:cold_beach", "minecraft:cold_ocean",
  "minecraft:deep_cold_ocean", "minecraft:legacy_frozen_ocean",
  "minecraft:frozen_peaks", "minecraft:jagged_peaks", "minecraft:snowy_slopes",
  "minecraft:frozen_ocean", "minecraft:deep_frozen_ocean", "minecraft:frozen_river"
]);
const HOT_BIOMES = new Set([
  "minecraft:desert", "minecraft:badlands", "minecraft:eroded_badlands",
  "minecraft:wooded_badlands", "minecraft:savanna", "minecraft:savanna_plateau",
  "minecraft:windswept_savanna", "minecraft:desert_hills", "minecraft:desert_mutated",
  "minecraft:mesa", "minecraft:mesa_bryce", "minecraft:mesa_mutated",
  "minecraft:mesa_plateau", "minecraft:mesa_plateau_mutated",
  "minecraft:mesa_plateau_stone", "minecraft:mesa_plateau_stone_mutated",
  "minecraft:savanna_mutated", "minecraft:savanna_plateau_mutated"
]);
const HEAT_BLOCKS = new Set(["minecraft:campfire", "minecraft:soul_campfire", "minecraft:fire"]);
const WARM_FOODS = new Set(["minecraft:mushroom_stew", "minecraft:rabbit_stew",
  "minecraft:beetroot_soup", "minecraft:suspicious_stew"]);
const ARMOR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];
const states = new Map();
const warned = new Set();
let scoreboardWarned = false;

export function temperatureEnabled() {
  return statusEnabled("temperature");
}

export function setTemperatureEnabled(enabled) {
  setStatusEnabled("temperature", enabled);
  if (!enabled) {
    for (const player of world.getAllPlayers()) {
      const state = stateFor(player);
      state.activity = state.damageSeconds = 0;
      state.mining = undefined;
      state.wasJumping = false;
      setWetSeconds(state, 0);
      setEffects(player, 2);
    }
  }
}

function activeMode(player) {
  const mode = player.getGameMode();
  return mode === GameMode.Survival || mode === GameMode.Adventure;
}

function clamp(value) { return Math.max(0, Math.min(100, value)); }

function sampleLocation(dimension, location) {
  const { min, max } = dimension.heightRange;
  return { x: location.x, y: Math.max(min, Math.min(max - 1, location.y)), z: location.z };
}

function rawTier(value) {
  return value < 15 ? 0 : value < 35 ? 1 : value <= 65 ? 2 : value < 85 ? 3 : 4;
}

function tierFor(value, previous) {
  const next = rawTier(value);
  if (next === previous || Math.abs(next - previous) > 1) return next;
  const edge = [15, 35, 66, 85][Math.min(next, previous)];
  return next > previous ? (value >= edge + 2 ? next : previous)
    : (value <= edge - 2 ? next : previous);
}

function stateFor(player) {
  let state = states.get(player.id);
  if (state) { state.player = player; return state; }
  const stored = player.getDynamicProperty(VALUE_KEY);
  const validStored = typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
  const oldScore = validStored !== undefined
    ? undefined : legacyScore(player, SCORE_ID);
  const value = clamp(validStored ?? oldScore ?? 50);
  if (oldScore !== undefined) player.setDynamicProperty(VALUE_KEY, value);
  const wet = player.getDynamicProperty(WET_KEY);
  const tier = rawTier(value);
  state = { player, value, saved: Math.round(value), tier, score: undefined,
    activity: 0, wasJumping: false, mining: undefined, damageSeconds: 0,
    wetSeconds: typeof wet === "number" && Number.isFinite(wet) ? Math.max(0, Math.min(90, wet)) : 0 };
  states.set(player.id, state);
  if (player.getDynamicProperty(TIER_KEY) !== tier) player.setDynamicProperty(TIER_KEY, tier);
  return state;
}

function setMultiplier(player, key, value) {
  const old = player.getDynamicProperty(key);
  if (value === 1) {
    if (old !== undefined) player.setDynamicProperty(key, undefined);
  } else if (old !== value) player.setDynamicProperty(key, value);
}

function setEffects(player, tier) {
  setMultiplier(player, STAMINA_MULTIPLIER_KEY, tier === 0 ? 0.5 : tier === 1 ? 0.8 : 1);
  setMultiplier(player, THIRST_MULTIPLIER_KEY, tier === 4 ? 1.5 : tier === 3 ? 1.25 : 1);
}

function setValue(state, value) {
  state.value = clamp(value);
  const rounded = Math.round(state.value);
  if (rounded !== state.saved) {
    state.player.setDynamicProperty(VALUE_KEY, rounded);
    state.saved = rounded;
  }
  const tier = tierFor(state.value, state.tier);
  if (tier !== state.tier) {
    state.tier = tier;
    state.player.setDynamicProperty(TIER_KEY, tier);
  }
  setEffects(state.player, temperatureEnabled() && activeMode(state.player) ? state.tier : 2);
}

function setWetSeconds(state, seconds) {
  const next = Math.max(0, Math.min(90, seconds));
  if (next === state.wetSeconds) return;
  state.wetSeconds = next;
  state.player.setDynamicProperty(WET_KEY, next || undefined);
}

function nearbyHeat(player, head) {
  const { x, y, z } = player.location;
  const origin = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  const topY = Math.max(origin.y + 1, Math.floor(head.y));
  const { min, max } = player.dimension.heightRange;
  let heat = 0;
  // ponytail: scan nearby blocks once per second; cache only if multiplayer profiling shows a cost.
  for (let blockY = Math.max(origin.y - 1, min); blockY <= Math.min(topY, max - 1); blockY++) for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const distance = Math.hypot(dx, dz);
      if (distance > 4) continue;
      let block;
      try { block = player.dimension.getBlock({ x: origin.x + dx, y: blockY, z: origin.z + dz }); }
      catch { continue; } // A scan cell can cross the dimension height boundary.
      const id = block?.typeId;
      const sourceHeat = id === "minecraft:lava" || id === "minecraft:flowing_lava" ? 30
        : HEAT_BLOCKS.has(id) ? 20 : 0;
      if (sourceHeat) heat = Math.max(heat, Math.round(sourceHeat * Math.min(1, (5 - distance) / 4)));
    }
  }
  return heat;
}

function leatherPieces(player) {
  const equipment = player.getComponent("minecraft:equippable");
  if (!equipment) return 0;
  return ARMOR_SLOTS.filter((slot) => equipment.getEquipment(slot)?.typeId.startsWith("minecraft:leather_")).length;
}

function movementHeat(player) {
  if (player.isGliding) return 0;
  if (player.isSwimming) return 4;
  if (player.isSprinting) return 5;
  if (player.isOnGround === false) return 0;
  const velocity = player.getVelocity();
  return velocity.x ** 2 + velocity.z ** 2 > 0.0025 ? 1 : 0;
}

function miningNow(state) {
  const block = state.mining;
  if (!block) return false;
  try {
    if (block.dimension.getBlock(block.location)?.typeId === block.typeId) return true;
  } catch { /* The chunk may have unloaded. */ }
  state.mining = undefined;
  return false;
}

function environment(player, activity = movementHeat(player) + (player.isJumping && !player.isSwimming ? 2 : 0),
  wetSeconds = 0) {
  const dimension = player.dimension;
  let target = dimension.id.endsWith("nether") ? 85 : dimension.id === "minecraft:the_end" ? 35 : 50;
  let coldBiome = false;
  let hotBiome = false;
  if (dimension.id.endsWith("overworld")) {
    const biome = dimension.getBiome(sampleLocation(dimension, player.location)).id;
    coldBiome = COLD_BIOMES.has(biome);
    hotBiome = HOT_BIOMES.has(biome);
    target = coldBiome ? 20 : hotBiome ? 75 : 50;
    target -= Math.min(20, Math.max(0, player.location.y - 96) / 8);
  }
  const head = player.getHeadLocation();
  const top = dimension.getTopmostBlock({ x: Math.floor(head.x), z: Math.floor(head.z) });
  const outdoors = !top || top.location.y < head.y;
  const time = world.getTimeOfDay();
  const weather = world.getDynamicProperty(WEATHER_KEY);
  const raining = dimension.id.endsWith("overworld") && outdoors &&
    (weather === "Rain" || weather === "Thunder");
  let sunny = false;
  if (dimension.id.endsWith("overworld") && outdoors) {
    if (raining) {
      if (!hotBiome) target -= 8;
    } else if (time >= 1000 && time <= 11000 && dimension.getSkyLightLevel(sampleLocation(dimension, head)) >= 14) {
      target += 5;
      sunny = true;
    }
    if (time >= 14000 && time <= 22000) target -= 6;
  }
  const burning = !!player.getComponent("minecraft:onfire");
  const heat = Math.max(burning ? 20 : 0, nearbyHeat(player, head));
  target += heat;
  if (player.isInWater) target -= coldBiome ? 20 : 10;
  if (player.isGliding) target -= 6;
  target += Math.min(10, activity);
  const wetNow = player.isInWater || raining;
  if (!wetNow && wetSeconds > 0) target -= 5 * wetSeconds / 90;
  const hunger = player.getComponent("minecraft:player.hunger")?.currentValue;
  if (target < 50) target -= hunger !== undefined && hunger <= 0 ? 10
    : hunger !== undefined && hunger <= 6 ? 5 : 0;
  const leather = leatherPieces(player);
  if (!wetNow && wetSeconds <= 0) target += 2 * leather;
  let rate = target === 50 ? 2 : 1;
  if (player.isInWater) rate *= 3;
  else if (outdoors && !hotBiome && raining && target < 50) rate *= 1.5;
  return { target: clamp(target), coolingRate: rate * (wetNow || wetSeconds > 0 ? 1 : 1 - leather / 8) *
    (player.isGliding ? 1.5 : 1),
    warmingRate: rate * (burning ? 3 : 1), wetNow, dryingFast: heat > 0 || sunny };
}

function applyTemperatureDamage(state) {
  const interval = state.value < 15 ? (state.player.isInWater ? 2 : 8)
    : state.value >= 85 ? 8 : 0;
  if (!interval) { state.damageSeconds = 0; return; }
  if (++state.damageSeconds < interval) return;
  state.damageSeconds = 0;
  state.player.applyDamage(1, { cause: EntityDamageCause.temperature });
}

function syncScore(state) {
  const score = Math.round(state.value);
  if (state.score === score) return;
  const result = state.player.runCommand(`scoreboard players set @s ${SCORE_ID} ${score}`);
  if (result.successCount < 1) throw new Error("无法更新温度计分板");
  state.score = score;
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "ot:temperature_test") return;
  const player = event.sourceEntity;
  if (player?.typeId !== "minecraft:player" || player.playerPermissionLevel !== PlayerPermissionLevel.Operator) return;
  const state = stateFor(player);
  const command = event.message.trim().toLowerCase();
  if (command === "off") {
    player.setDynamicProperty(DEBUG_KEY, undefined);
    player.sendMessage("§7温度测试显示已关闭。§r");
  }
  else if (command === "on" || /^(?:100|[1-9]?\d)$/.test(command)) {
    player.setDynamicProperty(DEBUG_KEY, true);
    setValue(state, command === "on" ? 50 : Number(command));
    player.sendMessage(`§a温度目标：${Math.round(state.value)}。§r`);
  } else player.sendMessage("§e用法：/scriptevent ot:temperature_test on|off|0..100§r");
});

world.afterEvents.weatherChange.subscribe(({ dimension, newWeather }) => {
  if (dimension.endsWith("overworld")) world.setDynamicProperty(WEATHER_KEY, newWeather);
});

world.afterEvents.itemCompleteUse.subscribe(({ source, itemStack }) => {
  if (source?.typeId !== "minecraft:player" || !temperatureEnabled() || !activeMode(source) ||
      !WARM_FOODS.has(itemStack.typeId)) return;
  const state = stateFor(source);
  setValue(state, state.value + 8);
});

world.afterEvents.playerSwingStart.subscribe(({ player, swingSource }) => {
  if (swingSource === "Attack" && temperatureEnabled() && activeMode(player))
    stateFor(player).activity += 2;
});

world.afterEvents.playerStartBreakingBlock.subscribe(({ player, block }) => {
  if (temperatureEnabled() && activeMode(player))
    stateFor(player).mining = { dimension: block.dimension, location: { ...block.location }, typeId: block.typeId };
});

function stopMining({ player, block }) {
  const state = states.get(player.id);
  if (state?.mining && state.mining.location.x === block.location.x &&
      state.mining.location.y === block.location.y && state.mining.location.z === block.location.z)
    state.mining = undefined;
}

world.afterEvents.playerCancelBreakingBlock.subscribe(stopMining);
world.afterEvents.playerBreakBlock.subscribe(stopMining);

system.runInterval(() => {
  if (!temperatureEnabled()) return;
  for (const player of world.getAllPlayers()) {
    if (!activeMode(player)) continue;
    try {
      const state = stateFor(player);
      state.activity += movementHeat(player) / 20;
      if (player.isJumping && !state.wasJumping && !player.isSwimming) state.activity += 2;
      state.wasJumping = player.isJumping;
      if (miningNow(state)) state.activity += 2 / 20;
    } catch (error) {
      if (!warned.has(player.id)) console.warn(`[temperature] 玩家 ${player.id} 活动采样失败：${error}`);
      warned.add(player.id);
    }
  }
}, 1);

system.runInterval(() => {
  let objective;
  try {
    objective = world.scoreboard.getObjective(SCORE_ID);
    if (!objective) {
      objective = world.scoreboard.addObjective(SCORE_ID, SCORE_ID);
      for (const state of states.values()) state.score = undefined;
    }
    scoreboardWarned = false;
  } catch (error) {
    if (!scoreboardWarned) console.warn(`[temperature] 无法准备计分板：${error}`);
    scoreboardWarned = true;
  }
  for (const player of world.getAllPlayers()) {
    try {
      const state = stateFor(player);
      if (temperatureEnabled() && activeMode(player)) {
        const activity = state.activity;
        state.activity = 0;
        const { target, coolingRate, warmingRate, wetNow, dryingFast } =
          environment(player, activity, state.wetSeconds);
        setWetSeconds(state, wetNow ? 90 : state.wetSeconds - (dryingFast ? 3 : 1));
        const difference = target - state.value;
        setValue(state, state.value + Math.sign(difference) * Math.min(Math.abs(difference),
          difference < 0 ? coolingRate : warmingRate));
        applyTemperatureDamage(state);
      } else {
        state.activity = state.damageSeconds = 0;
        state.mining = undefined;
        state.wasJumping = false;
        setWetSeconds(state, 0);
        setEffects(player, 2);
      }
      if (!objective) continue;
      syncScore(state);
      warned.delete(player.id);
    } catch (error) {
      if (!warned.has(player.id)) console.warn(`[temperature] 玩家 ${player.id} 更新失败：${error}`);
      warned.add(player.id);
    }
  }
}, 20);

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) return;
  system.run(() => {
    try {
      const state = stateFor(player);
      state.activity = state.damageSeconds = 0;
      state.mining = undefined;
      state.wasJumping = false;
      setWetSeconds(state, 0);
      setValue(state, 50);
    }
    catch (error) { console.warn(`[temperature] 重生重置失败：${error}`); }
  });
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  states.delete(playerId);
  warned.delete(playerId);
});
