import { BlockVolume, GameMode, PlayerPermissionLevel, system, world } from "@minecraft/server";
import { legacyScore, statusEnabled, setStatusEnabled } from "../status_flags.js";

const VALUE_KEY = "ot:sanity_value";
const DEBUG_KEY = "ot:sanity_debug";
const LAST_SLEEP_KEY = "ot:sanity_last_sleep";
const SLEEP_REWARD_KEY = "ot:sanity_sleep_reward";
const ACTIVE_TICKS_KEY = "ot:sanity_active_ticks";
const PANIC_AT_KEY = "ot:sanity_panic_at";
const PANIC_FULL_KEY = "ot:sanity_panic_full";
const THIRST_HURT_KEY = "ot:thirst_hurt_tick";
const HURT_WINDOW_KEY = "ot:sanity_hurt_window";
const HURT_TOTAL_KEY = "ot:sanity_hurt_total";
const SCORE_ID = "ot_sanity";
const DAY = 24000;
const MINUTE = 1200;
const MUSIC_RADIUS = 8;
const MUSIC_GAIN_PER_SECOND = 2 / 60;
const states = new Map();
const warned = new Set();
let scoreboardWarned = false;
let ticks = 0;

export function sanityEnabled() {
  return statusEnabled("sanity");
}

export function setSanityEnabled(enabled) {
  setStatusEnabled("sanity", enabled);
}

const clamp = (value) => Math.max(0, Math.min(100, value));
const storedNumber = (player, key, fallback) => {
  const value = player.getDynamicProperty(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};
const activeMode = (player) => {
  const mode = player.getGameMode();
  return mode === GameMode.Survival || mode === GameMode.Adventure;
};
const randomDelay = () => (45 + Math.floor(Math.random() * 46)) * 20;

function stateFor(player) {
  let state = states.get(player.id);
  if (state) { state.player = player; return state; }
  const stored = player.getDynamicProperty(VALUE_KEY);
  const validStored = typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
  const oldScore = validStored !== undefined
    ? undefined : legacyScore(player, SCORE_ID);
  const value = clamp(validStored ?? oldScore ?? 100);
  if (oldScore !== undefined) player.setDynamicProperty(VALUE_KEY, value);
  const now = world.getAbsoluteTime();
  const lastSleep = storedNumber(player, LAST_SLEEP_KEY, now);
  if (player.getDynamicProperty(LAST_SLEEP_KEY) === undefined)
    player.setDynamicProperty(LAST_SLEEP_KEY, lastSleep);
  state = {
    player, value, saved: Math.round(value), score: undefined,
    activeTicks: storedNumber(player, ACTIVE_TICKS_KEY, 0),
    lastSleep, sleepReward: storedNumber(player, SLEEP_REWARD_KEY, -DAY),
    panicAt: storedNumber(player, PANIC_AT_KEY, -1),
    panicFull: player.getDynamicProperty(PANIC_FULL_KEY) === true,
    wasSleeping: false, darkSeconds: 0, weakActive: false, darkActive: false,
    weakNext: undefined, soundNext: undefined,
    darknessRefresh: 0,
    hurtWindow: storedNumber(player, HURT_WINDOW_KEY, -1),
    hurtTotal: storedNumber(player, HURT_TOTAL_KEY, 0)
  };
  states.set(player.id, state);
  return state;
}

function setValue(state, value) {
  const previous = state.value;
  state.value = clamp(value);
  const rounded = Math.round(state.value);
  if (rounded !== state.saved) {
    state.player.setDynamicProperty(VALUE_KEY, rounded);
    state.saved = rounded;
  }
  if (state.panicAt >= 0 && state.value >= 100 && !state.panicFull) {
    state.panicFull = true;
    state.player.setDynamicProperty(PANIC_FULL_KEY, true);
  }
  if (sanityEnabled() && activeMode(state.player) && previous >= 75 && state.value < 75 &&
      (state.panicAt < 0 || state.panicFull && state.activeTicks - state.panicAt >= DAY)) {
    state.player.addEffect("speed", 120, { amplifier: 0, showParticles: false });
    state.panicAt = state.activeTicks;
    state.panicFull = false;
    state.player.setDynamicProperty(ACTIVE_TICKS_KEY, state.activeTicks);
    state.player.setDynamicProperty(PANIC_AT_KEY, state.activeTicks);
    state.player.setDynamicProperty(PANIC_FULL_KEY, false);
  }
}

function sleepCheck(state, now) {
  const sleeping = state.player.isSleeping;
  if (sleeping && !state.wasSleeping && sanityEnabled() && activeMode(state.player) &&
      now - state.sleepReward >= DAY / 2) {
    state.lastSleep = now;
    state.sleepReward = now;
    state.player.setDynamicProperty(LAST_SLEEP_KEY, now);
    state.player.setDynamicProperty(SLEEP_REWARD_KEY, now);
    setValue(state, state.value + 20);
  }
  state.wasSleeping = sleeping;
}

function pressure(state, now) {
  const player = state.player;
  const hunger = player.getComponent("minecraft:player.hunger")?.currentValue;
  const thirst = storedNumber(player, "ot:thirst_value", 100);
  const tier = player.getDynamicProperty("ot:temperature_tier");
  const temperatureOn = statusEnabled("temperature");
  const thirstOn = statusEnabled("thirst");
  let light;
  try { light = player.dimension.getLightLevel(player.getHeadLocation()); }
  catch { light = undefined; }
  state.darkSeconds = light !== undefined && light <= 4 ? state.darkSeconds + 1 : 0;
  const dark = state.darkSeconds >= 30;
  const sleepAge = now - state.lastSleep;
  const sleepLoss = sleepAge >= 3 * DAY ? 2 : sleepAge >= 2 * DAY ? 1 : 0;
  const hungerLoss = hunger === 0 ? 2 : hunger !== undefined && hunger <= 6 ? 1 : 0;
  const thirstLoss = !thirstOn ? 0 : thirst <= 0 ? 2 : thirst < 20 ? 1 : 0;
  const tempLoss = !temperatureOn ? 0 : tier === 0 || tier === 4 ? 2
    : tier === 1 || tier === 3 ? 1 : 0;
  const netherLoss = player.dimension.id === "minecraft:nether" ? 0.5 : 0;
  const totalLoss = Math.min(3, hungerLoss + thirstLoss + tempLoss + (dark ? 2 : 0) + sleepLoss + netherLoss);
  const safe = !totalLoss && light !== undefined && light >= 8 && (!temperatureOn || tier === 2);
  return safe ? 3 / 60 : -totalLoss / 60;
}

function musicNearby(player) {
  try {
    const head = player.getHeadLocation();
    const dimension = player.dimension;
    const { min, max } = dimension.heightRange;
    const lowerY = Math.max(min, Math.floor(head.y - MUSIC_RADIUS));
    const upperY = Math.min(max - 1, Math.floor(head.y + MUSIC_RADIUS));
    if (lowerY > upperY) return false;
    const volume = new BlockVolume(
      { x: Math.floor(head.x - MUSIC_RADIUS), y: lowerY, z: Math.floor(head.z - MUSIC_RADIUS) },
      { x: Math.floor(head.x + MUSIC_RADIUS), y: upperY, z: Math.floor(head.z + MUSIC_RADIUS) });
    // One native filtered search per second, not a JavaScript loop over every nearby block.
    const locations = dimension.getBlocks(volume, { includeTypes: ["minecraft:jukebox"] }, true)
      .getBlockLocationIterator();
    for (const location of locations) {
      const distanceSquared = (location.x + 0.5 - head.x) ** 2 +
        (location.y + 0.5 - head.y) ** 2 + (location.z + 0.5 - head.z) ** 2;
      if (distanceSquared > MUSIC_RADIUS ** 2) continue;
      try {
        if (dimension.getBlock(location)?.getComponent("minecraft:record_player")?.isPlaying()) return true;
      } catch { /* One removed or unloaded jukebox must not hide the others. */ }
    }
  } catch { /* Unavailable chunks or an invalid search region cannot grant a music bonus. */ }
  return false;
}

function effects(state) {
  const player = state.player;
  const now = state.activeTicks;
  if (state.value < 50) {
    if (!state.weakActive) {
      state.weakActive = true;
      state.weakNext = now + randomDelay();
    }
  } else if (state.value >= 53) {
    state.weakActive = false;
    state.weakNext = undefined;
  }
  if (state.weakActive && now >= state.weakNext) {
    player.addEffect("weakness", 100, { amplifier: 0, showParticles: false });
    state.weakNext = now + randomDelay();
  }

  if (state.value < 25) {
    if (!state.darkActive) {
      state.darkActive = true;
      state.darknessRefresh = 0;
      state.soundNext = now + randomDelay();
    }
  } else if (state.value >= 28) {
    state.darkActive = false;
    state.soundNext = undefined;
  }
  if (!state.darkActive) return;
  if (state.darknessRefresh <= 0) {
    player.addEffect("darkness", 140, { amplifier: 0, showParticles: false });
    state.darknessRefresh = 80;
  }
  state.darknessRefresh -= 20;
  if (now >= state.soundNext) {
    player.playSound("ambient.cave", { volume: 0.6, pitch: 0.8 });
    state.soundNext = now + randomDelay();
  }
}

function syncScore(state) {
  const score = Math.round(state.value);
  if (state.score === score) return;
  const result = state.player.runCommand(`scoreboard players set @s ${SCORE_ID} ${score}`);
  if (result.successCount < 1) throw new Error(`无法更新 ${SCORE_ID} 计分板`);
  state.score = score;
}

world.afterEvents.entityHurt.subscribe(({ hurtEntity, damage, damageSource }) => {
  if (hurtEntity.typeId !== "minecraft:player" || !sanityEnabled() || !activeMode(hurtEntity)) return;
  try {
    const marked = hurtEntity.getDynamicProperty(THIRST_HURT_KEY);
    if (damageSource?.cause === "none" && typeof marked === "number" &&
        system.currentTick - marked >= 0 && system.currentTick - marked <= 1) {
      hurtEntity.setDynamicProperty(THIRST_HURT_KEY, undefined);
      return;
    }
    const state = stateFor(hurtEntity);
    const now = state.activeTicks;
    if (state.hurtWindow < 0 || now - state.hurtWindow >= MINUTE || now < state.hurtWindow) {
      state.hurtWindow = now;
      state.hurtTotal = 0;
      hurtEntity.setDynamicProperty(ACTIVE_TICKS_KEY, now);
      hurtEntity.setDynamicProperty(HURT_WINDOW_KEY, now);
    }
    const loss = Math.min(8, Math.max(0, damage), 12 - state.hurtTotal);
    if (loss <= 0) return;
    state.hurtTotal += loss;
    hurtEntity.setDynamicProperty(HURT_TOTAL_KEY, state.hurtTotal);
    setValue(state, state.value - loss);
  } catch (error) { console.warn(`[sanity] 受伤处理失败：${error}`); }
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "ot:sanity_test") return;
  const player = world.getAllPlayers().find((candidate) => candidate.id === event.sourceEntity?.id);
  if (!player || player.playerPermissionLevel !== PlayerPermissionLevel.Operator) return;
  const command = event.message.trim().toLowerCase();
  const state = stateFor(player);
  if (command === "off") {
    player.setDynamicProperty(DEBUG_KEY, undefined);
    player.sendMessage("§7理智条测试显示已关闭。§r");
  } else if (command === "on" || /^(?:100|[1-9]?\d)$/.test(command)) {
    player.setDynamicProperty(DEBUG_KEY, true);
    setValue(state, command === "on" ? 100 : Number(command));
    player.sendMessage(`§a理智目标：${Math.round(state.value)}。§r`);
  } else player.sendMessage("§e用法：/scriptevent ot:sanity_test on|off|0..100§r");
});

system.runInterval(() => {
  ticks++;
  const now = world.getAbsoluteTime();
  const update = ticks % 20 === 0;
  let objective;
  if (update) try {
    objective = world.scoreboard.getObjective(SCORE_ID);
    if (!objective) {
      objective = world.scoreboard.addObjective(SCORE_ID, SCORE_ID);
      for (const state of states.values()) state.score = undefined;
    }
    scoreboardWarned = false;
  } catch (error) {
    if (!scoreboardWarned) console.warn(`[sanity] 无法准备计分板：${error}`);
    scoreboardWarned = true;
  }
  for (const player of world.getAllPlayers()) try {
    const state = stateFor(player);
    state.activeTicks++;
    if (update) player.setDynamicProperty(ACTIVE_TICKS_KEY, state.activeTicks);
    sleepCheck(state, now);
    if (!update) continue;
    if (sanityEnabled() && activeMode(player)) {
      const change = pressure(state, now);
      const music = (state.value < 100 || change < 0) && musicNearby(player);
      setValue(state, state.value + change + (music ? MUSIC_GAIN_PER_SECOND : 0));
      effects(state);
    } else {
      state.darkSeconds = 0;
      state.weakActive = state.darkActive = false;
      state.weakNext = state.soundNext = undefined;
      state.darknessRefresh = 0;
    }
    if (objective) syncScore(state);
    warned.delete(player.id);
  } catch (error) {
    if (!warned.has(player.id)) console.warn(`[sanity] 玩家 ${player.id} 更新失败：${error}`);
    warned.add(player.id);
  }
}, 1);

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) return;
  system.run(() => {
    try {
      const state = stateFor(player);
      const now = world.getAbsoluteTime();
      state.lastSleep = now;
      state.sleepReward = -DAY;
      state.panicAt = -1;
      state.panicFull = false;
      state.darkSeconds = 0;
      state.weakActive = state.darkActive = false;
      state.hurtTotal = 0;
      state.hurtWindow = -1;
      player.setDynamicProperty(LAST_SLEEP_KEY, now);
      player.setDynamicProperty(SLEEP_REWARD_KEY, undefined);
      player.setDynamicProperty(PANIC_AT_KEY, undefined);
      player.setDynamicProperty(PANIC_FULL_KEY, undefined);
      player.setDynamicProperty(HURT_WINDOW_KEY, undefined);
      player.setDynamicProperty(HURT_TOTAL_KEY, undefined);
      setValue(state, 100);
    } catch (error) { console.warn(`[sanity] 重生重置失败：${error}`); }
  });
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  states.delete(playerId);
  warned.delete(playerId);
});
