import { EquipmentSlot, GameMode, InputPermissionCategory, PlayerPermissionLevel, system, world } from "@minecraft/server";
import { legacyScore, statusEnabled, setStatusEnabled } from "../status_flags.js";
import { hudPositionMarkers } from "../hud_positions.js";

const EVENT_ID = "ot:stamina_test";
const THIRST_EVENT_ID = "ot:thirst_test";
const VALUE_KEY = "ot:stamina_value";
const THIRST_KEY = "ot:thirst_value";
const THIRST_LOSS_MULTIPLIER_KEY = "ot:thirst_loss_multiplier";
const WEATHER_KEY = "ot:temperature_weather";
const STAMINA_RECOVERY_MULTIPLIER_KEY = "ot:stamina_recovery_multiplier";
const TEMPERATURE_TIER_KEY = "ot:temperature_tier";
const TEMPERATURE_DEBUG_KEY = "ot:temperature_debug";
const SANITY_VALUE_KEY = "ot:sanity_value";
const SANITY_DEBUG_KEY = "ot:sanity_debug";
const THIRST_HURT_KEY = "ot:thirst_hurt_tick";
const EXHAUSTED_KEY = "ot:stamina_exhausted";
const JUMP_OWNED_KEY = "ot:stamina_jump_owned";
const DISPLAY_LEVELS = 96;
const TITLE_OPTIONS = { fadeInDuration: 0, stayDuration: 0, fadeOutDuration: 0 };
const SPRINT_COST = 0.15;
const SWIM_COST = 0.2;
const JUMP_COST = 2;
const ARMOR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];
const ARMOR_LOAD = { chainmail: 0.05, copper: 0.075, golden: 0.1, iron: 0.1,
  diamond: 0.075, netherite: 0.125 };
const SLOW_RECOVERY = 0.2;
const FAST_RECOVERY = 0.4;
const MIN_BLOCK_COST = 1;
const BOW_COST = 0.05;
const CROSSBOW_COST = 0.1;
const UNLOCK_AT = 20;
const PASSIVE_THIRST_LOSS = 1 / 400;
// Independent thirst prices, numerically 0.025 per matching exertion point.
const SPRINT_THIRST_EXTRA = 0.00375;
const SWIM_THIRST_EXTRA = 0.005;
const JUMP_THIRST_LOSS = 0.05;
const MIN_BLOCK_THIRST_LOSS = 0.025;
const INJURY_CAUSES = new Set(["entityAttack", "maceSmash", "projectile", "fall",
  "blockExplosion", "entityExplosion"]);
const BOW_THIRST_EXTRA = 0.00125;
const CROSSBOW_THIRST_EXTRA = 0.0025;
const HIT_THIRST_LOSS = 0.05;
const UNDERWATER_THIRST_GAIN = 1 / 20;
const RAIN_THIRST_GAIN = 0.005;
const SEA_BIOMES = new Set([
  "minecraft:ocean", "minecraft:deep_ocean", "minecraft:warm_ocean", "minecraft:deep_warm_ocean",
  "minecraft:lukewarm_ocean", "minecraft:deep_lukewarm_ocean",
  "minecraft:cold_ocean", "minecraft:deep_cold_ocean", "minecraft:frozen_ocean",
  "minecraft:deep_frozen_ocean", "minecraft:legacy_frozen_ocean"
]);
const DRINK_GAIN = { "minecraft:milk_bucket": 20, "minecraft:beetroot_soup": 10,
  "minecraft:mushroom_stew": 10, "minecraft:rabbit_stew": 10,
  "minecraft:suspicious_stew": 10 };
const SCORE_OBJECTIVES = [["ot_stamina", "staminaScore"], ["ot_thirst", "thirstScore"]];
const states = new Map();
const warned = new Set();
let scoreboardWarned = false;

export function staminaEnabled() {
  return statusEnabled("stamina");
}

export function setStaminaEnabled(enabled) {
  setStatusEnabled("stamina", enabled);
  if (!enabled) for (const state of states.values()) state.recoveryBlockedTicks = 0;
}

export function thirstEnabled() {
  return statusEnabled("thirst");
}

export function setThirstEnabled(enabled) {
  setStatusEnabled("thirst", enabled);
}

function activeMode(player) {
  const mode = player.getGameMode();
  return mode === GameMode.Survival || mode === GameMode.Adventure;
}

function stateFor(player) {
  let state = states.get(player.id);
  if (state) {
    state.player = player;
    return state;
  }
  const stored = player.getDynamicProperty(VALUE_KEY);
  const validStored = typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
  const oldScore = validStored !== undefined
    ? undefined : legacyScore(player, "ot_stamina");
  const value = Math.max(0, Math.min(100, validStored ?? oldScore ?? 100));
  if (oldScore !== undefined) player.setDynamicProperty(VALUE_KEY, value);
  const storedThirst = player.getDynamicProperty(THIRST_KEY);
  const validThirst = typeof storedThirst === "number" && Number.isFinite(storedThirst)
    ? storedThirst : undefined;
  const oldThirstScore = validThirst !== undefined
    ? undefined : legacyScore(player, "ot_thirst");
  const thirst = Math.max(0, Math.min(100, validThirst ?? oldThirstScore ?? 100));
  if (oldThirstScore !== undefined) player.setDynamicProperty(THIRST_KEY, thirst);
  state = {
    player,
    value,
    display: value,
    saved: Math.round(value),
    thirst,
    thirstDisplay: thirst,
    sanityDisplay: Number.isFinite(player.getDynamicProperty(SANITY_VALUE_KEY))
      ? Math.max(0, Math.min(100, player.getDynamicProperty(SANITY_VALUE_KEY))) : 100,
    thirstSaved: Math.round(thirst),
    waterSample: undefined,
    armorSample: undefined,
    thirstDebug: false,
    damageTicks: 0,
    damageSevere: false,
    nauseaTicks: 0,
    exhausted: player.getDynamicProperty(EXHAUSTED_KEY) === true ||
      (player.getDynamicProperty(EXHAUSTED_KEY) === undefined && value < UNLOCK_AT &&
        !player.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Jump)),
    ownedJump: player.getDynamicProperty(JUMP_OWNED_KEY) === true,
    wasGrounded: undefined,
    title: "",
    debug: false,
    slowRefresh: 0,
    chargingWeapon: undefined,
    lastMeleeHitTick: undefined,
    lastMeleeTargetId: undefined,
    recoveryBlockedTicks: 0
  };
  states.set(player.id, state);
  return state;
}

function ensureScoreObjectives() {
  for (const [id, field] of SCORE_OBJECTIVES) {
    if (world.scoreboard.getObjective(id)) continue;
    world.scoreboard.addObjective(id, id);
    for (const state of states.values()) state[field] = undefined;
  }
}

function syncScore(state, id, field, value) {
  if (state[field] === value) return;
  const result = state.player.runCommand(`scoreboard players set @s ${id} ${value}`);
  if (result.successCount < 1) throw new Error(`无法更新 ${id} 计分板`);
  state[field] = value;
}

function syncScores(state) {
  syncScore(state, "ot_stamina", "staminaScore", Math.round(state.value));
  syncScore(state, "ot_thirst", "thirstScore", Math.round(state.thirst));
}

function setThirst(state, value) {
  state.thirst = Math.max(0, Math.min(100, value));
  const rounded = Math.round(state.thirst);
  if (rounded !== state.thirstSaved) {
    state.player.setDynamicProperty(THIRST_KEY, rounded);
    state.thirstSaved = rounded;
  }
}

function thirstLossMultiplier(player) {
  const value = player.getDynamicProperty(THIRST_LOSS_MULTIPLIER_KEY);
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 1;
}

function staminaRecoveryMultiplier(player) {
  const value = player.getDynamicProperty(STAMINA_RECOVERY_MULTIPLIER_KEY);
  const temperature = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  const hunger = player.getComponent("minecraft:player.hunger")?.currentValue;
  return temperature * (hunger === 0 ? 0.5 : hunger !== undefined && hunger <= 6 ? 0.75 : 1);
}

function armorExertionMultiplier(state) {
  // ponytail: load is sampled once per second; equipment-change signals can tighten swap latency later.
  if (!state.armorSample || system.currentTick - state.armorSample.tick >= 20) {
    const equipment = state.player.getComponent("minecraft:equippable");
    let load = 0;
    if (equipment) for (const slot of ARMOR_SLOTS) {
      const id = equipment.getEquipment(slot)?.typeId ?? "";
      const match = /^minecraft:(chainmail|copper|golden|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(id);
      load += match ? ARMOR_LOAD[match[1]] : 0;
    }
    state.armorSample = { tick: system.currentTick, multiplier: 1 + Math.min(0.5, load) };
  }
  return state.armorSample.multiplier;
}

function headInWater(player) {
  if (!player.isInWater) return false;
  try {
    const block = player.dimension.getBlock(player.getHeadLocation());
    return block?.typeId === "minecraft:water" || block?.typeId === "minecraft:flowing_water"
      || block?.typeId === "minecraft:bubble_column";
  } catch { return false; } // An unreadable head cell must not stop the other status updates.
}

function freshWater(state) {
  const player = state.player;
  const dimension = player.dimension;
  const sample = state.waterSample;
  if (!sample || sample.dimension !== dimension.id || system.currentTick - sample.tick >= 20) {
    const next = { dimension: dimension.id, tick: system.currentTick, fresh: false };
    // ponytail: infer salt from the immersion biome, not water provenance; resample once per second.
    try {
      const head = player.getHeadLocation();
      const { min, max } = dimension.heightRange;
      const biome = dimension.getBiome({ x: Math.floor(head.x),
        y: Math.max(min, Math.min(max - 1, Math.floor(head.y))), z: Math.floor(head.z) }).id;
      next.fresh = typeof biome === "string" && !SEA_BIOMES.has(biome);
    } catch { /* Unknown water does not grant hydration; retry on the next sample. */ }
    state.waterSample = next;
  }
  return state.waterSample.fresh;
}

function exposedToRain(player) {
  if (player.dimension.id !== "minecraft:overworld") return false;
  const weather = world.getDynamicProperty(WEATHER_KEY);
  if (weather !== "Rain" && weather !== "Thunder") return false;
  const head = player.getHeadLocation();
  try {
    const top = player.dimension.getTopmostBlock({ x: Math.floor(head.x), z: Math.floor(head.z) });
    return !top || top.location.y < head.y;
  } catch { return false; }
}

function loseThirst(state, amount) {
  if (thirstEnabled() && (!exposedToRain(state.player) || headInWater(state.player)))
    setThirst(state, state.thirst - thirstLossMultiplier(state.player) * amount);
}

function tickThirst(state, jumped, chargingWeapon, exertion) {
  const player = state.player;
  const movement = (player.isSwimming ? SWIM_THIRST_EXTRA
    : player.isSprinting ? SPRINT_THIRST_EXTRA : 0) * exertion;
  const submerged = headInWater(player);
  if (!submerged) state.waterSample = undefined;
  const hydrating = submerged && freshWater(state);
  const raining = !submerged && exposedToRain(player);
  const change = hydrating ? UNDERWATER_THIRST_GAIN
    : raining ? RAIN_THIRST_GAIN
      : -thirstLossMultiplier(player) * (PASSIVE_THIRST_LOSS + movement
      + (jumped ? JUMP_THIRST_LOSS * exertion : 0)
      + (chargingWeapon === "minecraft:crossbow" ? CROSSBOW_THIRST_EXTRA
        : chargingWeapon ? BOW_THIRST_EXTRA : 0));
  setThirst(state, state.thirst + change);

  const severe = state.thirst <= 0;
  if (severe) {
    if (state.nauseaTicks <= 0) {
      player.addEffect("nausea", 200, { amplifier: 0, showParticles: false });
      state.nauseaTicks = 160;
    }
    state.nauseaTicks--;
  } else state.nauseaTicks = 0;
  if (state.thirst >= 20) state.damageTicks = 0;
  else {
    if (severe !== state.damageSevere) state.damageTicks = 0;
    if (++state.damageTicks >= (severe ? 40 : 100)) {
      player.setDynamicProperty(THIRST_HURT_KEY, system.currentTick);
      if (!player.applyDamage(1)) player.setDynamicProperty(THIRST_HURT_KEY, undefined);
      state.damageTicks = 0;
    }
  }
  state.damageSevere = severe;
}

function hydrationFor(item) {
  // Script API 2.3 cannot inspect potion contents; water and drinkable potions share this gain.
  if (item.typeId === "minecraft:potion") return 20;
  return DRINK_GAIN[item.typeId] ?? 0;
}

function saveValue(state) {
  const rounded = Math.round(state.value);
  if (rounded === state.saved) return;
  state.player.setDynamicProperty(VALUE_KEY, rounded);
  state.saved = rounded;
}

function syncExhaustion(state, enabled) {
  if (enabled !== state.exhausted) {
    state.exhausted = enabled;
    state.player.setDynamicProperty(EXHAUSTED_KEY, enabled);
  }
  const permissions = state.player.inputPermissions;
  if (enabled) {
    if (permissions.isPermissionCategoryEnabled(InputPermissionCategory.Jump)) {
      if (!state.ownedJump) {
        state.player.setDynamicProperty(JUMP_OWNED_KEY, true);
        state.ownedJump = true;
      }
      permissions.setPermissionCategory(InputPermissionCategory.Jump, false);
    }
  } else if (state.ownedJump) {
    permissions.setPermissionCategory(InputPermissionCategory.Jump, true);
    state.player.setDynamicProperty(JUMP_OWNED_KEY, false);
    state.ownedJump = false;
  }
}

function updateExhaustion(state) {
  if (state.value <= 0) syncExhaustion(state, true);
  else if (state.value >= UNLOCK_AT) syncExhaustion(state, false);
}

function setValue(state, value) {
  state.value = Math.max(0, Math.min(100, value));
  saveValue(state);
  if (activeMode(state.player) && staminaEnabled()) updateExhaustion(state);
  else syncExhaustion(state, false);
}

// Read-only: safe to use from before-events, including other block scripts.
export function staminaAllowsAction(player) {
  if (!staminaEnabled() || !activeMode(player)) return true;
  const state = states.get(player.id);
  const value = state?.value ?? player.getDynamicProperty(VALUE_KEY) ?? legacyScore(player, "ot_stamina") ?? 100;
  const storedExhausted = player.getDynamicProperty(EXHAUSTED_KEY);
  const exhausted = state?.exhausted ?? (storedExhausted === true ||
    storedExhausted === undefined && value < UNLOCK_AT &&
      !player.inputPermissions.isPermissionCategoryEnabled(InputPermissionCategory.Jump));
  return value > 0 && !exhausted;
}

function markMeleeHit(player, target) {
  if (!activeMode(player) || (!staminaEnabled() && !thirstEnabled())) return;
  const state = stateFor(player);
  const tick = system.currentTick;
  const targetId = target?.id;
  // Contact and damage callbacks can both report one attack; never charge that attack twice.
  if (state.lastMeleeHitTick === tick ||
      targetId && targetId === state.lastMeleeTargetId && tick - state.lastMeleeHitTick <= 1) return;
  if (staminaEnabled() && staminaAllowsAction(player)) {
    setValue(state, state.value - 2);
    state.recoveryBlockedTicks = 10;
  }
  loseThirst(state, HIT_THIRST_LOSS);
  state.lastMeleeHitTick = tick;
  state.lastMeleeTargetId = targetId;
}

function publish(state) {
  const active = activeMode(state.player);
  const staminaVisible = staminaEnabled() && (active || state.debug);
  const thirstVisible = thirstEnabled() && (active || state.thirstDebug);
  const temperatureVisible = statusEnabled("temperature") &&
    (active || state.player.getDynamicProperty(TEMPERATURE_DEBUG_KEY) === true);
  const sanityVisible = statusEnabled("sanity") &&
    (active || state.player.getDynamicProperty(SANITY_DEBUG_KEY) === true);
  if (!staminaVisible && !thirstVisible && !temperatureVisible && !sanityVisible) return hide(state);
  let title = "OT_STATUS|";
  if (staminaVisible) {
    const delta = state.value - state.display;
    state.display += Math.sign(delta) * Math.min(Math.abs(delta), 4);
    title += `S:${Math.round(state.display * DISPLAY_LEVELS / 100)}|`;
  }
  if (thirstVisible) {
    const delta = state.thirst - state.thirstDisplay;
    state.thirstDisplay += Math.sign(delta) * Math.min(Math.abs(delta), 4);
    title += `T:${Math.round(state.thirstDisplay * DISPLAY_LEVELS / 100)}|`;
  }
  if (temperatureVisible) {
    const tier = state.player.getDynamicProperty(TEMPERATURE_TIER_KEY);
    title += `C:${Number.isInteger(tier) && tier >= 0 && tier <= 4 ? tier : 2}|`;
  }
  if (sanityVisible) {
    const stored = state.player.getDynamicProperty(SANITY_VALUE_KEY);
    const value = typeof stored === "number" && Number.isFinite(stored)
      ? Math.max(0, Math.min(100, stored)) : 100;
    const delta = value - state.sanityDisplay;
    state.sanityDisplay += Math.sign(delta) * Math.min(Math.abs(delta), 4);
    title += `M:${Math.round(state.sanityDisplay * DISPLAY_LEVELS / 100)}|`;
  }
  title += hudPositionMarkers(state.player);
  if (title === state.title) return;
  state.player.onScreenDisplay.setTitle(title, TITLE_OPTIONS);
  state.title = title;
}

function hide(state) {
  if (!state.title) return;
  state.player.onScreenDisplay.setTitle("OT_STATUS_OFF", TITLE_OPTIONS);
  state.title = "";
}

function tickPlayer(state, staminaOn, thirstOn) {
  const player = state.player;
  const grounded = player.isOnGround;
  const velocity = player.getVelocity();
  const still = velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2 <= 0.0009;
  const jumped = state.wasGrounded === true && !grounded && velocity.y > 0.08 && player.isJumping;
  const recovery = staminaRecoveryMultiplier(player);
  const exertion = player.isSwimming || player.isSprinting || jumped ? armorExertionMultiplier(state) : 1;
  state.wasGrounded = grounded;
  const chargingWeapon = state.chargingWeapon;

  if (staminaOn) {
    const recoveryBlocked = state.recoveryBlockedTicks > 0;
    if (recoveryBlocked) state.recoveryBlockedTicks--;
    updateExhaustion(state);
    if (state.exhausted) syncExhaustion(state, true);
    if (state.exhausted) {
      const rate = player.isInWater || player.isGliding || !still && !player.isSneaking ? SLOW_RECOVERY : FAST_RECOVERY;
      setValue(state, state.value + (recoveryBlocked ? 0 : rate * recovery));
    } else {
      let change;
      if (player.isSwimming) change = -SWIM_COST * exertion;
      else if (player.isGliding) change = SLOW_RECOVERY;
      else if (player.isSprinting) change = -SPRINT_COST * exertion;
      else if (player.isInWater) change = SLOW_RECOVERY;
      else change = player.isSneaking || still ? FAST_RECOVERY : SLOW_RECOVERY;
      if (change > 0 && (chargingWeapon || recoveryBlocked)) change = 0;
      if (chargingWeapon) change -= chargingWeapon === "minecraft:crossbow" ? CROSSBOW_COST : BOW_COST;
      setValue(state, state.value + (change > 0 ? change * recovery : change) - (jumped ? JUMP_COST * exertion : 0));
    }
    if (state.exhausted && !chargingWeapon && (player.isSprinting || player.isSwimming)) {
      if (state.slowRefresh <= 0) {
        player.addEffect("slowness", 6, { amplifier: 2, showParticles: false });
        state.slowRefresh = 3;
      }
      state.slowRefresh--;
    } else state.slowRefresh = 0;
  } else {
    syncExhaustion(state, false);
    state.slowRefresh = 0;
    state.recoveryBlockedTicks = 0;
  }
  if (thirstOn) tickThirst(state, jumped, chargingWeapon, exertion);
  else {
    state.waterSample = undefined;
    state.damageTicks = 0;
    state.damageSevere = false;
    state.nauseaTicks = 0;
  }
  if (player.isValid !== false) publish(state);
}

world.afterEvents.entityHitEntity.subscribe(({ damagingEntity, hitEntity }) => {
  if (damagingEntity.typeId === "minecraft:player") markMeleeHit(damagingEntity, hitEntity);
});

world.afterEvents.entityHurt.subscribe(({ hurtEntity, damage, damageSource }) => {
  if (damage > 0 && (damageSource?.cause === "entityAttack" || damageSource?.cause === "maceSmash") &&
      damageSource.damagingEntity?.typeId === "minecraft:player")
    markMeleeHit(damageSource.damagingEntity, hurtEntity);
  if (hurtEntity.typeId !== "minecraft:player" || !activeMode(hurtEntity) || !staminaEnabled() ||
      damage <= 0 || !INJURY_CAUSES.has(damageSource?.cause)) return;
  try {
    const state = stateFor(hurtEntity);
    setValue(state, state.value - 2);
    state.recoveryBlockedTicks = 10;
  } catch (error) { console.warn(`[stamina] 受伤扣体力失败：${error}`); }
});

world.afterEvents.playerBreakBlock.subscribe(({ player }) => {
  if (activeMode(player) && (staminaEnabled() || thirstEnabled())) {
    const state = stateFor(player);
    if (staminaEnabled() && !state.exhausted)
      setValue(state, state.value - MIN_BLOCK_COST);
    loseThirst(state, MIN_BLOCK_THIRST_LOSS);
  }
});

world.afterEvents.itemStartUse.subscribe(({ source, itemStack }) => {
  if ((itemStack.typeId === "minecraft:bow" || itemStack.typeId === "minecraft:crossbow") && activeMode(source) &&
      (staminaEnabled() || thirstEnabled()))
    stateFor(source).chargingWeapon = itemStack.typeId;
});

function stopCharging({ source }) {
  const state = states.get(source.id);
  if (state) state.chargingWeapon = undefined;
}

world.afterEvents.itemStopUse.subscribe(stopCharging);
world.afterEvents.itemReleaseUse.subscribe(stopCharging);
world.afterEvents.playerHotbarSelectedSlotChange.subscribe(({ player }) => {
  const state = states.get(player.id);
  if (state) {
    state.chargingWeapon = undefined;
  }
});

world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (!staminaAllowsAction(event.player)) event.cancel = true;
});

world.beforeEvents.itemUse.subscribe((event) => {
  if ((event.itemStack.typeId === "minecraft:bow" || event.itemStack.typeId === "minecraft:crossbow") &&
      !staminaAllowsAction(event.source))
    event.cancel = true;
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== EVENT_ID && event.id !== THIRST_EVENT_ID) return;
  const player = world.getAllPlayers().find((candidate) => candidate.id === event.sourceEntity?.id);
  if (!player) return;
  if (player.playerPermissionLevel !== PlayerPermissionLevel.Operator) return;
  const command = event.message.trim().toLowerCase();
  const state = stateFor(player);
  if (event.id === THIRST_EVENT_ID) {
    if (command === "off") {
      state.thirstDebug = false;
      publish(state);
      player.sendMessage("§7口渴条测试已关闭；生存／冒险模式仍自动运行。§r");
    } else if (command === "on" || /^(?:100|[1-9]?\d)$/.test(command)) {
      state.thirstDebug = true;
      setThirst(state, command === "on" ? 100 : Number(command));
      state.thirstDisplay = state.thirst;
      publish(state);
      player.sendMessage(`§a口渴目标：${Math.round(state.thirst)}%。§r`);
    } else player.sendMessage("§e用法：/scriptevent ot:thirst_test on|off|0..100§r");
    return;
  }
  if (command === "off") {
    state.debug = false;
    publish(state);
    player.sendMessage("§7体力条测试已关闭；生存／冒险模式的体力系统仍会自动运行。§r");
  } else if (command === "on") {
    state.debug = true;
    setValue(state, 100);
    state.display = 100;
    publish(state);
    player.sendMessage("§a体力条测试已开启：100%。§r");
  } else if (/^(?:100|[1-9]?\d)$/.test(command)) {
    state.debug = true;
    setValue(state, Number(command));
    publish(state);
    player.sendMessage(`§a体力目标：${command}%。§r`);
  } else player.sendMessage("§e用法：/scriptevent ot:stamina_test on|off|0..100§r");
});

world.afterEvents.itemCompleteUse.subscribe(({ source, itemStack }) => {
  if (itemStack.typeId === "minecraft:crossbow") { stopCharging({ source }); return; }
  try {
    if (!thirstEnabled() || !activeMode(source)) return;
    const gain = hydrationFor(itemStack);
    if (gain <= 0) return;
    const state = stateFor(source);
    setThirst(state, state.thirst + gain);
    publish(state);
  } catch (error) {
    console.warn(`[thirst] 饮用物品处理失败：${error}`);
  }
});

system.runInterval(() => {
  const staminaOn = staminaEnabled();
  const thirstOn = thirstEnabled();
  let scoresReady = false;
  try {
    ensureScoreObjectives();
    scoresReady = true;
    scoreboardWarned = false;
  } catch (error) {
    if (!scoreboardWarned) console.warn(`[stamina] 无法准备状态计分板：${error}`);
    scoreboardWarned = true;
  }
  for (const player of world.getAllPlayers()) {
    try {
      const active = activeMode(player);
      const state = stateFor(player);
      state.player = player;
      if (active && (staminaOn || thirstOn)) tickPlayer(state, staminaOn, thirstOn);
      else {
        syncExhaustion(state, false);
        state.lastMeleeHitTick = state.lastMeleeTargetId = undefined;
        state.chargingWeapon = undefined;
        state.wasGrounded = undefined;
        state.waterSample = undefined;
        state.armorSample = undefined;
        state.damageTicks = 0;
        state.damageSevere = false;
        state.nauseaTicks = 0;
        state.recoveryBlockedTicks = 0;
        publish(state);
      }
      if (scoresReady) syncScores(state);
      warned.delete(player.id);
    } catch (error) {
      if (!warned.has(player.id)) console.warn(`[stamina] 玩家 ${player.id} 更新失败：${error}`);
      warned.add(player.id);
    }
  }
}, 1);

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) return;
  system.run(() => {
    try {
      const state = stateFor(player);
      setValue(state, 100);
      setThirst(state, 100);
      state.display = 100;
      state.thirstDisplay = 100;
      state.wasGrounded = undefined;
      state.waterSample = undefined;
      state.armorSample = undefined;
      state.damageTicks = 0;
      state.damageSevere = false;
      state.nauseaTicks = 0;
      state.lastMeleeHitTick = state.lastMeleeTargetId = undefined;
      state.chargingWeapon = undefined;
      state.recoveryBlockedTicks = 0;
      if (activeMode(player) || state.debug || state.thirstDebug) publish(state);
    } catch (error) {
      console.warn(`[stamina] 重生时无法恢复体力：${error}`);
    }
  });
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  states.delete(playerId);
  warned.delete(playerId);
});
